import type { ChannelSnapshot, CrawlConfig, LowConfidenceReason, ScoreType } from '@hype/shared';
import { type Baseline, type BaselineParams, computeBaseline } from './baseline.js';
import { projectViews } from './maturity.js';
import { isFiniteNumber, robustLogZScore } from './robust.js';

/** Kanal geçmişi yetersizken VSR'ye düşerken kullanılan abone tabanı. */
export const VSR_SUBSCRIBER_FLOOR = 1000;

/**
 * Taban çizgisi bu sayıdan az örneğe dayanıyorsa hype, VSR ile sınırlanır.
 * 5–7 örnekli bir medyan tek bir şanslı videoyla oynayabilir; abone oranı
 * bağımsız bir ikinci görüş sunar.
 */
export const THIN_HISTORY_MAX_N = 7;

/** Düşük güven bayrağının eşikleri. */
export const LOW_CONFIDENCE_MIN_N = 8;
export const LOW_CONFIDENCE_MIN_BASELINE = 1000;
export const LOW_CONFIDENCE_MIN_AGE_DAYS = 2;

export interface ScoreInput {
  videoId: string;
  views: number;
  ageDays: number;
}

export interface ScoredResult {
  scoreType: ScoreType;
  hype: number | null;
  vsr: number | null;
  z: number | null;
  projectedViews: number;
  baselineMedian: number | null;
  baselineN: number | null;
  baselineSamples: number[];
  lowConfidence: boolean;
  /** Bayrağın SEBEPLERİ. Boşsa lowConfidence de false'tur. */
  lowConfidenceReasons: LowConfidenceReason[];
  channelIsHot: boolean;
}

export type ScoreOutcome =
  | { kind: 'scored'; score: ScoredResult }
  /** Ne kullanılabilir taban çizgisi ne de abone sayısı var — skor uydurulmaz. */
  | { kind: 'insufficient' };

type ScoreConfig = BaselineParams & Pick<CrawlConfig, 'vsrThreshold'>;

export function toBaselineParams(config: CrawlConfig): BaselineParams {
  return {
    baselineSize: config.baselineSize,
    baselineLookbackDays: config.baselineLookbackDays,
    baselineFloor: config.baselineFloor,
    baselineMinN: config.baselineMinN,
  };
}

/**
 * Adayı kanalın kendi geçmişine göre skorlar.
 *
 * İki metrik asla karıştırılmaz: `scoreType` hangisinin geçerli olduğunu söyler,
 * diğeri null kalır. Bir kanalın medyan-çarpanıyla başka birinin abone-oranını
 * aynı kolonda sıralamak, kullanıcıya yalan söylemektir.
 */
export function scoreVideo(
  input: ScoreInput,
  snapshot: ChannelSnapshot,
  config: ScoreConfig,
): ScoreOutcome {
  const projected = projectViews(input.views, input.ageDays);
  const baseline = computeBaseline(input.videoId, input.ageDays, snapshot.recentUploads, config);
  const subs = isFiniteNumber(snapshot.subsApprox) ? snapshot.subsApprox : null;

  // Altın yıldız: kanalın tipik videosu abone sayısını aşıyorsa, kanalın kendisi
  // algoritmadan pay alıyor demektir — kartta öne çıkarılır.
  const channelIsHot =
    baseline !== null && subs !== null && subs > 0 ? baseline.rawViewMedian > subs : false;

  if (baseline === null) {
    // Tier 2 — kanal geçmişi yok/yetersiz. Aboneye göre oran, ayrı bir metrik
    // olarak ayrı bir kolonda saklanır.
    if (subs === null) return { kind: 'insufficient' };
    const vsr = projected / Math.max(subs, VSR_SUBSCRIBER_FLOOR);
    if (!isFiniteNumber(vsr) || vsr <= 0) return { kind: 'insufficient' };
    return {
      kind: 'scored',
      score: {
        scoreType: 'vsr',
        hype: null,
        vsr,
        z: null,
        projectedViews: projected,
        baselineMedian: null,
        baselineN: null,
        baselineSamples: [],
        lowConfidence: true, // taban çizgisi olmadan her VSR skoru zayıf kanıttır
        lowConfidenceReasons: ['no_baseline'],
        channelIsHot,
      },
    };
  }

  // Tier 1 — asıl metrik.
  let hype = projected / baseline.value;

  // İnce geçmiş frenleme: 5–7 örnekli bir tabanla üretilen dev çarpanlar,
  // abone oranı desteklemiyorsa kırpılır.
  if (baseline.n <= THIN_HISTORY_MAX_N && subs !== null) {
    const vsr = projected / Math.max(subs, VSR_SUBSCRIBER_FLOOR);
    hype = Math.min(hype, 2 * vsr);
  }

  if (!isFiniteNumber(hype) || hype <= 0) return { kind: 'insufficient' };

  const lowConfidenceReasons: LowConfidenceReason[] = [];
  if (baseline.n < LOW_CONFIDENCE_MIN_N) lowConfidenceReasons.push('thin_baseline');
  if (baseline.value < LOW_CONFIDENCE_MIN_BASELINE) lowConfidenceReasons.push('tiny_baseline');
  if (input.ageDays < LOW_CONFIDENCE_MIN_AGE_DAYS) lowConfidenceReasons.push('young_video');
  if (baseline.flooredUp) lowConfidenceReasons.push('baseline_floored');
  if (baseline.usedNewerUploads) lowConfidenceReasons.push('newer_uploads_only');

  return {
    kind: 'scored',
    score: {
      scoreType: 'hype',
      hype,
      vsr: null,
      z: robustLogZScore(projected, baseline.samples),
      projectedViews: projected,
      baselineMedian: baseline.value,
      baselineN: baseline.n,
      baselineSamples: baseline.samples,
      lowConfidence: lowConfidenceReasons.length > 0,
      lowConfidenceReasons,
      channelIsHot,
    },
  };
}

/**
 * Satın alınmış trafik şüphesi (yuben-app'ten alınan sezgi): 1000 izlenmede
 * 1.5'ten az beğeni, organik olmayan trafiğin en ucuz göstergesi.
 *
 * Beğeni sayısı feed kartlarında yoktur; yalnızca export zenginleştirmesinde
 * `getInfo()` çağrıldığında hesaplanabilir. Tarama sırasında bayrak false kalır.
 */
export function suspectsBoughtTraffic(likes: number | null, views: number): boolean {
  if (!isFiniteNumber(likes) || views < 1000) return false;
  return (likes / views) * 1000 < 1.5;
}

export type { Baseline };
