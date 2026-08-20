import type { ChannelSnapshot, GatewayErrorKind, RawVideoCard } from '@hype/shared';
import type { Clock, Sleeper } from '../ports/clock.js';
import type { CachedChannel, ChannelCacheRepo, ChannelVerdict, SeenRepo } from '../ports/repos.js';
import {
  type ChannelAbout,
  GatewayError,
  type VideoDetails,
  type WatchNextPage,
  type YouTubeGateway,
} from '../ports/youtube.js';
import { makeCard } from './factories.js';

/**
 * Sanal saat. `sleep` anında döner ve zamanı ileri sarar; böylece 4 saatlik bir
 * cooldown senaryosu milisaniyede koşar.
 */
export class FakeClock implements Clock, Sleeper {
  constructor(private t = 1_754_500_000_000) {}

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return;
    this.t += Math.max(0, ms);
  }
}

export interface FakeScenario {
  homeFeed?: RawVideoCard[];
  /** Sorgu → sonuç. '*' anahtarı tüm sorgular için varsayılan. */
  searchFeed?: Record<string, RawVideoCard[]>;
  /** videoId → o videonun öneri rafı. */
  edges?: Record<string, RawVideoCard[]>;
  channels?: Record<string, ChannelSnapshot>;
  /** channelId → ülke (getAbout benzeri ek istek). */
  /**
   * Kanalın "Hakkında" verisi — ülke ve kuruluş tarihi tek istekten gelir.
   * `joinedAtMs` mutlak epoch: `FakeClock` sabit bir andan başladığı için
   * "5 ay önce açıldı" deterministik olarak yazılabiliyor.
   */
  abouts?: Record<string, { country: string | null; joinedAtMs: number | null }>;
  /** İlk N watch-next çağrısı boş döner (sessiz kısıtlama simülasyonu). */
  emptyWatchNextCount?: number;
  /** Global istek sırası (1-tabanlı) → fırlatılacak hata türü. */
  errors?: Record<number, GatewayErrorKind>;
  /**
   * `edges` içinde tanımlanmamış videolar için üretilecek sıradan komşular.
   * Gerçek YouTube'da bir videonun öneri rafı asla boş değildir; bu olmadan
   * yaprak düğümler yanlışlıkla "sessiz kısıtlama" sinyaline dönüşür.
   */
  filler?: { count: number; channelId: string; views: number; ageDays?: number };
}

/**
 * Senaryo güdümlü sahte gateway. Gerçek InnerTube'un tek taklit edilen yanı
 * sözleşmesi; hız sınırı, ayrıştırma ve oturum kimliği adaptörün derdi.
 */
export class FakeYouTubeGateway implements YouTubeGateway {
  requests = 0;
  homeFeedCalls = 0;
  searchCalls = 0;
  watchNextCalls = 0;
  channelCalls = 0;
  aboutCalls = 0;
  detailCalls = 0;

  constructor(private readonly scenario: FakeScenario = {}) {}

  async fetchHomeFeed(): Promise<RawVideoCard[]> {
    this.tick();
    this.homeFeedCalls += 1;
    return [...(this.scenario.homeFeed ?? [])];
  }

  async fetchSearchFeed(query: string): Promise<RawVideoCard[]> {
    this.tick();
    this.searchCalls += 1;
    return [...(this.scenario.searchFeed?.[query] ?? this.scenario.searchFeed?.['*'] ?? [])];
  }

  async fetchWatchNext(videoId: string): Promise<WatchNextPage> {
    this.tick();
    this.watchNextCalls += 1;
    if (this.watchNextCalls <= (this.scenario.emptyWatchNextCount ?? 0)) {
      return { cards: [], continuation: null };
    }
    const explicit = this.scenario.edges?.[videoId];
    if (explicit !== undefined) return { cards: [...explicit], continuation: null };

    const filler = this.scenario.filler;
    if (filler === undefined) return { cards: [], continuation: null };
    const cards = Array.from({ length: filler.count }, (_, i) =>
      makeCard({
        videoId: `${videoId}~${i}`,
        channelId: filler.channelId,
        viewsApprox: filler.views,
        publishedAgeDays: filler.ageDays ?? 10,
      }),
    );
    return { cards, continuation: null };
  }

  async fetchChannelSnapshot(channelId: string): Promise<ChannelSnapshot> {
    this.tick();
    this.channelCalls += 1;
    const snapshot = this.scenario.channels?.[channelId];
    if (snapshot === undefined) {
      throw new GatewayError('not_found', `Kanal bulunamadı: ${channelId}`);
    }
    return snapshot;
  }

  async fetchChannelAbout(channelId: string): Promise<ChannelAbout> {
    this.tick();
    this.aboutCalls += 1;
    return this.scenario.abouts?.[channelId] ?? { country: null, joinedAtMs: null };
  }

  async fetchVideoDetails(videoId: string): Promise<VideoDetails> {
    this.tick();
    this.detailCalls += 1;
    return { videoId, description: null, publishedAt: null, views: null, likes: null };
  }

  private tick(): void {
    this.requests += 1;
    const kind = this.scenario.errors?.[this.requests];
    if (kind !== undefined) throw new GatewayError(kind, `Senaryo hatası: ${kind}`);
  }
}

export class MemoryChannelCache implements ChannelCacheRepo {
  private entries = new Map<string, CachedChannel>();
  reads = 0;
  writes = 0;

  async get(channelId: string): Promise<CachedChannel | null> {
    this.reads += 1;
    return this.entries.get(channelId) ?? null;
  }

  async putSnapshot(
    snapshot: ChannelSnapshot,
    verdict: ChannelVerdict,
    verdictExpiresAt: number | null,
    fetchedAt: number,
  ): Promise<void> {
    this.writes += 1;
    this.entries.set(snapshot.channelId, {
      channelId: snapshot.channelId,
      snapshot,
      subsApprox: snapshot.subsApprox,
      country: this.entries.get(snapshot.channelId)?.country ?? snapshot.country,
      joinedAt: this.entries.get(snapshot.channelId)?.joinedAt ?? null,
      verdict,
      verdictExpiresAt,
      snapshotFetchedAt: fetchedAt,
    });
  }

  async putVerdict(
    channelId: string,
    verdict: ChannelVerdict,
    verdictExpiresAt: number | null,
  ): Promise<void> {
    this.writes += 1;
    const existing = this.entries.get(channelId);
    this.entries.set(channelId, {
      channelId,
      snapshot: existing?.snapshot ?? null,
      subsApprox: existing?.subsApprox ?? null,
      country: existing?.country ?? null,
      joinedAt: existing?.joinedAt ?? null,
      verdict,
      verdictExpiresAt,
      snapshotFetchedAt: existing?.snapshotFetchedAt ?? null,
    });
  }

  async putAbout(
    channelId: string,
    country: string | null,
    joinedAt: number | null,
  ): Promise<void> {
    const existing = this.entries.get(channelId);
    this.entries.set(channelId, {
      channelId,
      snapshot: existing?.snapshot ?? null,
      subsApprox: existing?.subsApprox ?? null,
      // null gelen alan bilinen doğruyu EZMEZ (port sözleşmesi).
      country: country ?? existing?.country ?? null,
      joinedAt: joinedAt ?? existing?.joinedAt ?? null,
      verdict: existing?.verdict ?? 'unknown',
      verdictExpiresAt: existing?.verdictExpiresAt ?? null,
      snapshotFetchedAt: existing?.snapshotFetchedAt ?? null,
    });
  }
}

export class MemorySeenRepo implements SeenRepo {
  readonly ids = new Set<string>();

  constructor(initial: readonly string[] = []) {
    for (const id of initial) this.ids.add(id);
  }

  async has(videoId: string): Promise<boolean> {
    return this.ids.has(videoId);
  }

  async add(videoId: string): Promise<void> {
    this.ids.add(videoId);
  }
}
