import type {
  ChannelSnapshot,
  CrawlConfig,
  GateName,
  RawVideoCard,
  SkipReason,
} from '@hype/shared';
import { isFiniteNumber } from '../scoring/robust.js';
import {
  type ScoredResult,
  type ScoreOutcome,
  scoreVideo,
  toBaselineParams,
} from '../scoring/score.js';
import { viewsPerDay } from '../scoring/velocity.js';

/** Ücretsiz kapıları geçmiş, sayısal alanları garanti dolu aday. */
export interface Candidate {
  videoId: string;
  title: string;
  channelId: string;
  channelName: string | null;
  thumbnailUrl: string | null;
  durationSec: number;
  views: number;
  ageDays: number;
  vpd: number;
  sourceNodeType: string;
}

export interface GateSkip {
  kind: 'skip';
  stage: GateName;
  reason: SkipReason;
}

export type FreeGateResult = { kind: 'pass'; candidate: Candidate } | GateSkip;

function skip(stage: GateName, reason: SkipReason): GateSkip {
  return { kind: 'skip', stage, reason };
}

const KIND_REJECTIONS: Record<string, SkipReason> = {
  short: 'shorts',
  live: 'live',
  upcoming: 'upcoming',
  mix: 'mix_playlist',
  playlist: 'mix_playlist',
  movie: 'movie',
  unknown: 'unknown_kind',
};

/**
 * Kapı 0 — biçim. Tamamen bedava; feed yükünde zaten var olan alanlara bakar.
 *
 * Shorts elemesi adaptördeki normalizer'da yapısal olarak yapılır (node tipi,
 * content_type, süre, dikey kapak). Burada yalnızca sonucu uygularız — süreye
 * bakarak Shorts ayıklamak Ekim 2024'ten beri güvenilir değil (sınır 3 dakikaya
 * çıktı ve birçok yatay video da 3 dakikanın altında).
 */
export function gateShape(
  card: RawVideoCard,
  isSeen: (videoId: string) => boolean,
): GateSkip | null {
  const rejection = KIND_REJECTIONS[card.kind];
  if (rejection !== undefined) return skip('shape', rejection);
  // Kanal kimliği olmayan kart skorlanamaz — kanal geçmişi çekilemez.
  if (card.channelId === null || card.channelId.length === 0) {
    return skip('shape', 'parse_error');
  }
  // Süresi olmayan "video": canlı yayın / prömiyer imzası.
  if (!isFiniteNumber(card.durationSec)) return skip('shape', 'live');
  if (isSeen(card.videoId)) return skip('shape', 'seen');
  return null;
}

/**
 * Kapı 1 — sayısal ön filtre. Hâlâ bedava, ve sistemin en önemli kapısı:
 * graf trafiğinin %90-95'ini burada eleriz, böylece pahalı kanal isteği yalnızca
 * gerçekten aday olanlar için harcanır (spec'in "Veri Darboğazı" uyarısı).
 *
 * Parse edilemeyen metrik ASLA 0 varsayılmaz. "1.2M views" metnini okuyamadıysak
 * bunu sıfır izlenme saymak, o videoyu sessizce eler ve hatayı görünmez kılar;
 * ayrı bir sebep koduyla sayılır ki telemetri kırılmayı gösterebilsin.
 */
export function gatePrefilter(card: RawVideoCard, config: CrawlConfig): FreeGateResult {
  const { viewsApprox, publishedAgeDays } = card;
  if (!isFiniteNumber(viewsApprox) || !isFiniteNumber(publishedAgeDays)) {
    return skip('prefilter', 'unparseable_metrics');
  }
  // Her sınır bağımsız olarak kapatılabilir (null); kapalı sınır hiç bakılmaz.
  if (config.maxVideoAgeDays !== null && publishedAgeDays > config.maxVideoAgeDays) {
    return skip('prefilter', 'age_too_old');
  }
  if (config.minVideoAgeHours !== null && publishedAgeDays < config.minVideoAgeHours / 24) {
    return skip('prefilter', 'age_too_young');
  }
  if (config.minViews !== null && viewsApprox < config.minViews) {
    return skip('prefilter', 'views_too_low');
  }
  // Tavan: dev kanalların videolarını kanal isteği harcamadan eler.
  if (config.maxViews !== null && viewsApprox > config.maxViews) {
    return skip('prefilter', 'views_too_high');
  }

  const vpd = viewsPerDay(viewsApprox, publishedAgeDays);
  if (config.minVpd !== null && vpd < config.minVpd) return skip('prefilter', 'vpd_too_low');

  return {
    kind: 'pass',
    candidate: {
      videoId: card.videoId,
      title: card.title,
      // gateShape null olmadığını doğruladı; burada tip daraltması için tekrar kontrol.
      channelId: card.channelId ?? '',
      channelName: card.channelName,
      thumbnailUrl: card.thumbnailUrl,
      durationSec: card.durationSec ?? 0,
      views: viewsApprox,
      ageDays: publishedAgeDays,
      vpd,
      sourceNodeType: card.sourceNodeType,
    },
  };
}

/** Kapı 0 + Kapı 1 birlikte — motorun frontier kararları için tek çağrı. */
export function evaluateFreeGates(
  card: RawVideoCard,
  config: CrawlConfig,
  isSeen: (videoId: string) => boolean,
): FreeGateResult {
  const shapeSkip = gateShape(card, isSeen);
  if (shapeSkip !== null) return shapeSkip;
  return gatePrefilter(card, config);
}

/**
 * Kapı 3'ün abone kontrolü. Gizli abone sayısı REDDEDİLMEZ — kanal Shorts
 * ağırlıklı olmayan gerçek bir kanal olabilir; yalnızca Tier 1'e (medyan tabanlı)
 * mahkûm olur, VSR yedeğine düşemez.
 */
export function gateSubscriberRange(
  snapshot: ChannelSnapshot,
  config: CrawlConfig,
): GateSkip | null {
  if (snapshot.subsHidden || !isFiniteNumber(snapshot.subsApprox)) return null;
  return subscribersOutOfRange(snapshot.subsApprox, config)
    ? skip('channel_fetch', 'subs_out_of_range')
    : null;
}

/**
 * Abone sayısı kullanıcının aralığının dışında mı?
 *
 * İki sınır da kapalıysa (null) hiçbir kanal aralık dışı sayılmaz. Bu kontrol
 * ayrıca önbellekten okunurken de kullanılıyor: eski bir "aralık dışı" verdikti,
 * kullanıcı sınırı gevşettiğinde artık geçerli olmamalı.
 */
export function subscribersOutOfRange(
  subs: number | null,
  config: Pick<CrawlConfig, 'minSubs' | 'maxSubs'>,
): boolean {
  if (!isFiniteNumber(subs)) return false;
  if (config.minSubs !== null && subs < config.minSubs) return true;
  if (config.maxSubs !== null && subs > config.maxSubs) return true;
  return false;
}

export type ScoreGateResult = { kind: 'pass'; score: ScoredResult } | GateSkip;

/**
 * Kapı 4 — eşik. Tarama `crawlThreshold` (3.0x) ile kaydeder, arayüz
 * `hypeThreshold` (5.0x) ile gösterir. Böylece kullanıcı eşiği sonradan
 * düşürdüğünde yeni bir tarama gerekmez; veri zaten orada.
 */
export function gateScore(
  candidate: Candidate,
  snapshot: ChannelSnapshot,
  config: CrawlConfig,
): ScoreGateResult {
  const outcome: ScoreOutcome = scoreVideo(
    { videoId: candidate.videoId, views: candidate.views, ageDays: candidate.ageDays },
    snapshot,
    { ...toBaselineParams(config), vsrThreshold: config.vsrThreshold },
  );

  if (outcome.kind === 'insufficient') return skip('score', 'insufficient_data');

  const { score } = outcome;
  if (score.scoreType === 'hype') {
    if (score.hype === null || score.hype < config.crawlThreshold) {
      return skip('score', 'below_threshold');
    }
  } else if (score.vsr === null || score.vsr < config.vsrThreshold) {
    return skip('score', 'below_threshold');
  }

  return { kind: 'pass', score };
}
