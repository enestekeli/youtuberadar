import type { CrawlConfig, StopReason } from '@hype/shared';

/** Kanal anlık görüntüsü iki browse isteğine mal olur (başlık + Videos sekmesi). */
export const REQUESTS_PER_CHANNEL_FETCH = 2;

export interface BudgetSnapshot {
  videosScanned: number;
  channelFetches: number;
  requestsTotal: number;
  requestsClassA: number;
  requestsClassB: number;
}

/**
 * Oturum bütçeleri. Kullanıcıya görünür olması bilinçli: sistemin gerçek
 * maliyeti "kaç video tarandı" değil, "kaç kanal isteği harcandı".
 */
export class Budgets {
  private videosScanned = 0;
  private channelFetches = 0;
  private requestsClassA = 0;
  private requestsClassB = 0;

  constructor(private readonly config: CrawlConfig) {}

  get snapshot(): BudgetSnapshot {
    return {
      videosScanned: this.videosScanned,
      channelFetches: this.channelFetches,
      requestsTotal: this.requestsClassA + this.requestsClassB,
      requestsClassA: this.requestsClassA,
      requestsClassB: this.requestsClassB,
    };
  }

  recordScan(count = 1): void {
    this.videosScanned += count;
  }

  /** browse / search — ucuz sınıf. */
  recordClassA(count = 1): void {
    this.requestsClassA += count;
  }

  /** next / player — YouTube'un asıl ölçtüğü sınıf. */
  recordClassB(count = 1): void {
    this.requestsClassB += count;
  }

  recordChannelFetch(): void {
    this.channelFetches += 1;
    this.recordClassA(REQUESTS_PER_CHANNEL_FETCH);
  }

  hasChannelBudget(): boolean {
    return this.channelFetches < this.config.channelRequestBudget;
  }

  /** Bütçe bittiyse durma sebebini döner; aksi hâlde null. */
  exhausted(): StopReason | null {
    if (this.videosScanned >= this.config.maxVideosScanned) return 'max_videos';
    const total = this.requestsClassA + this.requestsClassB;
    if (total >= this.config.requestBudget) return 'budget_exhausted';
    return null;
  }

  restore(snapshot: BudgetSnapshot): void {
    this.videosScanned = snapshot.videosScanned;
    this.channelFetches = snapshot.channelFetches;
    this.requestsClassA = snapshot.requestsClassA;
    this.requestsClassB = snapshot.requestsClassB;
  }
}
