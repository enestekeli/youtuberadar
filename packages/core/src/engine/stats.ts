import type { CrawlConfig, FunnelStats, SkipReason } from '@hype/shared';
import type { Budgets } from './budgets.js';

export interface StatsSnapshotInput {
  now: number;
  frontierSize: number;
  depth: number;
  budgets: Budgets;
}

/**
 * Huni sayaçları. Arayüzdeki "tarandı 842 · ön-filtre 61 · kanal isteği 44"
 * şeridini ve oturum kaydını besler; taramanın verimli olup olmadığını
 * kullanıcıya tek bakışta gösteren şey bu.
 */
export class StatsCollector {
  private enqueued = 0;
  private expanded = 0;
  private matched = 0;
  private rejects: Partial<Record<SkipReason, number>> = {};
  private channelCacheHits = 0;
  private channelNegativeHits = 0;
  private channelFetches = 0;
  private http429 = 0;
  private emptyFeeds = 0;
  private loginRequired = 0;
  private parserWarnings = 0;

  constructor(
    private readonly config: CrawlConfig,
    readonly startedAt: number,
  ) {}

  recordEnqueue(count = 1): void {
    this.enqueued += count;
  }

  recordExpansion(): void {
    this.expanded += 1;
  }

  recordMatch(): void {
    this.matched += 1;
  }

  recordReject(reason: SkipReason): void {
    this.rejects[reason] = (this.rejects[reason] ?? 0) + 1;
  }

  recordChannelCacheHit(): void {
    this.channelCacheHits += 1;
  }

  recordChannelNegativeHit(): void {
    this.channelNegativeHits += 1;
  }

  recordChannelFetch(): void {
    this.channelFetches += 1;
  }

  recordThrottleSignal(kind: 'http429' | 'empty_feed' | 'login_required'): void {
    if (kind === 'http429') this.http429 += 1;
    else if (kind === 'empty_feed') this.emptyFeeds += 1;
    else this.loginRequired += 1;
  }

  recordParserWarning(): void {
    this.parserWarnings += 1;
  }

  snapshot({ now, frontierSize, depth, budgets }: StatsSnapshotInput): FunnelStats {
    const b = budgets.snapshot;
    return {
      scanned: b.videosScanned,
      enqueued: this.enqueued,
      expanded: this.expanded,
      matched: this.matched,
      depth,
      maxDepth: this.config.maxDepth,
      frontierSize,
      rejects: { ...this.rejects },
      channelCacheHits: this.channelCacheHits,
      channelFetches: this.channelFetches,
      channelNegativeHits: this.channelNegativeHits,
      requestsTotal: b.requestsTotal,
      requestsClassA: b.requestsClassA,
      requestsClassB: b.requestsClassB,
      http429: this.http429,
      emptyFeeds: this.emptyFeeds,
      loginRequired: this.loginRequired,
      parserWarnings: this.parserWarnings,
      channelBudgetCap: this.config.channelRequestBudget,
      requestBudgetCap: this.config.requestBudget,
      startedAt: this.startedAt,
      elapsedMs: Math.max(0, now - this.startedAt),
    };
  }
}
