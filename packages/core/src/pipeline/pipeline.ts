import type {
  ChannelSnapshot,
  CrawlConfig,
  GateName,
  RawVideoCard,
  SkipReason,
} from '@hype/shared';
import type { ScoredResult } from '../scoring/score.js';
import { checkCountry, countryFilterActive } from './country.js';
import { type Candidate, evaluateFreeGates, gateScore, gateSubscriberRange } from './gates.js';

/**
 * Kanal çözümlemesinin sonucu. Motor bunu önbellek + bütçe + ağ katmanından
 * üretir; boru hattı yalnızca sonucu yorumlar — böylece pipeline saf kalır.
 */
export type ChannelResolution =
  | { kind: 'snapshot'; snapshot: ChannelSnapshot; cacheHit: boolean }
  /** Negatif önbellek, kalıcı blocklist ya da erişilemeyen kanal. */
  | { kind: 'rejected'; reason: SkipReason }
  /** Kanal isteği bütçesi bitti — video elenir ama sebebi kalitesizlik değildir. */
  | { kind: 'budget_exhausted' };

export interface PipelineContext {
  config: CrawlConfig;
  isSeen: (videoId: string) => boolean;
  resolveChannel: (channelId: string) => Promise<ChannelResolution>;
  /**
   * Kanalın ülkesi. Ayrı bir istek gerektirdiği için EN SONA bırakıldı:
   * yalnızca abone aralığını ve skor eşiğini geçmiş adaylar için çağrılır,
   * yani tarama başına birkaç kez. Sonuç kalıcı önbelleğe girer.
   */
  resolveCountry: (channelId: string, snapshot: ChannelSnapshot) => Promise<string | null>;
}

export type PipelineResult =
  | {
      kind: 'skipped';
      stage: GateName;
      reason: SkipReason;
      /**
       * Ücretsiz kapıları geçtikten sonra elendiyse dolu olur. Motor bunu görünce
       * arayüzde gösterdiği "bekleyen kartı" geri çeker (pool:remove).
       */
      candidate: Candidate | null;
    }
  | {
      kind: 'matched';
      candidate: Candidate;
      score: ScoredResult;
      snapshot: ChannelSnapshot;
      cacheHit: boolean;
    };

/**
 * Beş kapıyı sırayla, ucuzdan pahalıya çalıştırır ve ilk elemede durur.
 *
 * Sıralamanın kendisi mimarinin en önemli maliyet kararı: yalnızca Kapı 3
 * InnerTube isteği harcar ve üç önbellek katmanının arkasındadır.
 */
export async function runPipeline(
  card: RawVideoCard,
  ctx: PipelineContext,
): Promise<PipelineResult> {
  const free = evaluateFreeGates(card, ctx.config, ctx.isSeen);
  if (free.kind === 'skip') {
    return { kind: 'skipped', stage: free.stage, reason: free.reason, candidate: null };
  }

  const { candidate } = free;

  // Kapı 2 + 3: önbellek isabetinde bedava, aksi hâlde 2 browse isteği.
  const resolution = await ctx.resolveChannel(candidate.channelId);
  if (resolution.kind === 'rejected') {
    return { kind: 'skipped', stage: 'channel_cache', reason: resolution.reason, candidate };
  }
  if (resolution.kind === 'budget_exhausted') {
    return {
      kind: 'skipped',
      stage: 'channel_fetch',
      reason: 'channel_budget_exhausted',
      candidate,
    };
  }

  const { snapshot, cacheHit } = resolution;

  const subsSkip = gateSubscriberRange(snapshot, ctx.config);
  if (subsSkip !== null) {
    return { kind: 'skipped', stage: subsSkip.stage, reason: subsSkip.reason, candidate };
  }

  const scored = gateScore(candidate, snapshot, ctx.config);
  if (scored.kind === 'skip') {
    return { kind: 'skipped', stage: scored.stage, reason: scored.reason, candidate };
  }

  // Ülke kapısı en sonda: buraya gelen aday zaten her şeyi geçti, dolayısıyla
  // ek istek yalnızca gerçek adaylar için harcanıyor.
  if (countryFilterActive(ctx.config.countries)) {
    const country = await ctx.resolveCountry(candidate.channelId, snapshot);
    const verdict = checkCountry(country, ctx.config.countries, ctx.config.allowUnknownCountry);
    if (verdict !== 'accepted') {
      return {
        kind: 'skipped',
        stage: 'score',
        reason: verdict === 'unknown' ? 'country_unknown' : 'country_mismatch',
        candidate,
      };
    }
  }

  return { kind: 'matched', candidate, score: scored.score, snapshot, cacheHit };
}
