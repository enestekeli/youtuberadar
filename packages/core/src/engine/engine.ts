import type {
  ChannelSnapshot,
  CrawlConfig,
  DomainEvent,
  EnginePhase,
  GateName,
  LowConfidenceReason,
  Match,
  RawVideoCard,
  SkipReason,
  StopReason,
} from '@hype/shared';
import type { TypedEventBus } from '../events/bus.js';
import { ThrottleDetector, type ThrottleTrip } from '../health/throttle-detector.js';
import { checkCountry, countryFilterActive } from '../pipeline/country.js';
import type { Candidate } from '../pipeline/gates.js';
import {
  evaluateFreeGates,
  gateSubscriberRange,
  subscribersOutOfRange,
} from '../pipeline/gates.js';
import { checkLanguage } from '../pipeline/language.js';
import { type ChannelResolution, runPipeline } from '../pipeline/pipeline.js';
import { checkTopic, topicDriftLimit } from '../pipeline/topic.js';
import type { Clock, Sleeper } from '../ports/clock.js';
import type { ChannelCacheRepo, ChannelVerdict, SeenRepo } from '../ports/repos.js';
import type { Rng } from '../ports/rng.js';
import { type ChannelAbout, isGatewayError, type YouTubeGateway } from '../ports/youtube.js';
import { type ChannelScore, channelScoreValue, scoreChannel } from '../scoring/channel-score.js';
import { projectViews } from '../scoring/maturity.js';
import { isFiniteNumber } from '../scoring/robust.js';
import type { ScoredResult } from '../scoring/score.js';
import { viewsPerDay } from '../scoring/velocity.js';
import { type BudgetSnapshot, Budgets } from './budgets.js';
import { DEFAULT_FRONTIER_CAPACITY, Frontier, type FrontierSnapshotEntry } from './frontier.js';
import { pickNext } from './policy.js';
import {
  canTransition,
  type EngineState,
  IllegalTransitionError,
  type ResumablePhase,
} from './state.js';
import { StatsCollector } from './stats.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Kanal anlık görüntüsünün tazelik süresi (yükleme listesi 6 saatte bayatlar). */
export const CHANNEL_SNAPSHOT_TTL_MS = 6 * HOUR;
/** Aralık dışı kanal verdiktinin ömrü — grafın sürekli gösterdiği devleri bedava eler. */
export const NEGATIVE_VERDICT_TTL_MS = 7 * DAY;
export const UNAVAILABLE_VERDICT_TTL_MS = DAY;
/** Bu abonenin üstü kalıcı kara listeye alınır (kullanıcı aralığından bağımsız). */
export const BLOCKLIST_SUBSCRIBER_THRESHOLD = 1_000_000;

/** Ana sayfa üst üste kullanılabilir tohum vermezse tarama ölümcül hatayla biter. */
export const MAX_SEED_ATTEMPTS = 5;
/** Birincil tohumun yanına yedek olarak kuyruğa alınacak ana sayfa kartı sayısı. */
export const SEED_BACKUP_COUNT = 4;
/**
 * Ön filtreyi geçemeyen ama gerçek yatay video olan kartlardan kaça dallanılır.
 * Yalnızca "iyi" düğümlerde yürümek keşfi kısırlaştırır: grafın gezilebilir
 * kalması için sıradan videolara da uğramak gerekir.
 */
export const EXPLORATION_SAMPLE_SIZE = 3;
/** Uzun bir kol diğer tohumları aç bırakmasın; düzenli olarak yeni sorgu eklenir. */
export const SEED_REFRESH_EXPANSIONS = 4;

export interface EngineSnapshot {
  runId: string;
  config: CrawlConfig;
  frontier: FrontierSnapshotEntry[];
  budgets: BudgetSnapshot;
  sessionSeen: string[];
  currentSeedId: string | null;
  currentDepth: number;
  /**
   * Kanal modunda bu taramada değerlendirilmiş kanallar.
   *
   * Opsiyonel: bu alan eklenmeden önce yazılmış anlık görüntülerde yok ve
   * boş kabul ediliyor — devam eden eski bir tarama kırılmaz, yalnızca birkaç
   * kanalı yeniden değerlendirir (önbellekten, ucuz).
   */
  evaluatedChannels?: string[];
  seedScans?: Record<string, number>;
  seededQueries?: string[];
  nextSeedIndex?: number;
  expansionsSinceSeed?: number;
}

interface WalkContext {
  seedKey: string;
  seedVideoId: string | null;
  seedQuery: string | null;
  topicMisses: number;
  topicScore: number | null;
  topicMatches: string[];
}

export interface EngineDeps {
  gateway: YouTubeGateway;
  channels: ChannelCacheRepo;
  seen: SeenRepo;
  clock: Clock;
  sleeper: Sleeper;
  rng: Rng;
  bus: TypedEventBus;
  frontierCapacity?: number;
  /** Çökme sonrası devam edebilmek için düzenli aralıklarla çağrılır. */
  persistSnapshot?: (snapshot: EngineSnapshot) => void | Promise<void>;
  snapshotEveryNExpansions?: number;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Tarama motoru.
 *
 * Tek süreç, tek sıralı döngü, aynı anda tek InnerTube isteği. Paralellik
 * bilinçli olarak yok: verim zaten YouTube'un hız sınırıyla belirleniyor, tek
 * akış hem hız ayarını kanıtlanabilir biçimde doğru kılıyor hem de olay
 * akışının nedensel sırasını koruyor.
 */
export class CrawlerEngine {
  private state: EngineState = { phase: 'idle' };
  private config: CrawlConfig | null = null;
  private runId: string | null = null;
  private frontier: Frontier;
  private budgets: Budgets | null = null;
  private stats: StatsCollector | null = null;
  private detector: ThrottleDetector;
  private sessionSeen = new Set<string>();
  private abort = new AbortController();
  private pauseRequested = false;
  private pauseGate: Deferred | null = null;
  private stopRequested: StopReason | null = null;
  private manualSeeds: string[] = [];
  private currentSeedId: string | null = null;
  private currentDepth = 0;
  private seedAttempts = 0;
  private homeFeedExhausted = false;
  private seedScans = new Map<string, number>();
  private seededQueries = new Set<string>();
  private nextSeedIndex = 0;
  private expansionsSinceSeed = 0;
  private expansionsSinceSnapshot = 0;
  /** Kanal modu: bu taramada değerlendirilmiş kanallar (kanal başına tek kart). */
  private evaluatedChannels = new Set<string>();
  /** "Hakkında" isteği bu taramada başarısız olan kanallar — tekrar denenmez. */
  private aboutFailedChannels = new Set<string>();
  private suspendedCooldown: { until: number; level: number; prior: ResumablePhase } | null = null;

  constructor(private readonly deps: EngineDeps) {
    this.frontier = new Frontier(deps.frontierCapacity ?? DEFAULT_FRONTIER_CAPACITY);
    this.detector = new ThrottleDetector(deps.clock);
  }

  get phase(): EnginePhase {
    return this.state.phase;
  }

  get currentState(): EngineState {
    return this.state;
  }

  /** Taramayı sıfırdan çalıştırır ve bitiş sebebiyle döner. */
  async start(runId: string, config: CrawlConfig): Promise<StopReason> {
    this.assertStartable();
    this.runId = runId;
    this.config = config;
    this.budgets = new Budgets(config);
    this.stats = new StatsCollector(config, this.deps.clock.now());
    this.frontier.clear();
    this.sessionSeen.clear();
    this.currentSeedId = null;
    this.currentDepth = 0;
    this.homeFeedExhausted = false;
    this.seedScans.clear();
    this.seededQueries.clear();
    this.nextSeedIndex = 0;
    this.expansionsSinceSeed = 0;
    this.evaluatedChannels.clear();
    this.aboutFailedChannels.clear();
    return this.runFrom(runId, config);
  }

  /**
   * Kesintiye uğramış bir taramayı kaldığı yerden sürdürür.
   *
   * Ana sayfa yeniden denenmez (`homeFeedExhausted`) ve bütçeler anlık
   * görüntüden gelir: yeniden başlatmak harcanan istek hakkını geri kazandırmaz.
   */
  async resumeFrom(snapshot: EngineSnapshot): Promise<StopReason> {
    this.assertStartable();
    this.restore(snapshot);
    this.homeFeedExhausted = true;
    return this.runFrom(snapshot.runId, snapshot.config);
  }

  private assertStartable(): void {
    if (this.state.phase !== 'idle' && this.state.phase !== 'stopped') {
      throw new Error(`Tarama zaten çalışıyor (${this.state.phase})`);
    }
    if (this.state.phase === 'stopped') this.transition({ phase: 'idle' });
  }

  private async runFrom(runId: string, config: CrawlConfig): Promise<StopReason> {
    this.detector = new ThrottleDetector(this.deps.clock);
    this.abort = new AbortController();
    this.pauseRequested = false;
    this.stopRequested = null;
    this.seedAttempts = 0;
    this.expansionsSinceSnapshot = 0;
    this.suspendedCooldown = null;

    this.emit({ type: 'run_started', runId, config });
    this.transition({ phase: 'seeding', attempt: 0 });
    if (this.frontier.size > 0) this.transition({ phase: 'crawling' });

    const reason = await this.runLoop();
    this.emit({ type: 'run_finished', runId, reason, stats: this.statsSnapshot() });
    return reason;
  }

  pause(): void {
    if (this.stopRequested !== null) return;
    this.pauseRequested = true;
  }

  resume(): void {
    this.pauseRequested = false;
    this.pauseGate?.resolve();
  }

  stop(reason: StopReason = 'manual'): void {
    this.stopRequested = reason;
    this.pauseRequested = false;
    this.pauseGate?.resolve();
    this.abort.abort();
  }

  /** Kullanıcının "buradan devam et" dediği video, ana sayfa tohumunun önüne geçer. */
  requestSeed(videoId: string): void {
    this.manualSeeds.push(videoId);
  }

  snapshot(): EngineSnapshot | null {
    if (this.runId === null || this.config === null || this.budgets === null) return null;
    return {
      runId: this.runId,
      config: this.config,
      frontier: this.frontier.snapshot(),
      budgets: this.budgets.snapshot,
      sessionSeen: [...this.sessionSeen],
      currentSeedId: this.currentSeedId,
      currentDepth: this.currentDepth,
      evaluatedChannels: [...this.evaluatedChannels],
      seedScans: Object.fromEntries(this.seedScans),
      seededQueries: [...this.seededQueries],
      nextSeedIndex: this.nextSeedIndex,
      expansionsSinceSeed: this.expansionsSinceSeed,
    };
  }

  /** Çökme sonrası kaldığı yerden devam. Bütçeler de geri yüklenir — restart bütçe sıfırlamaz. */
  restore(snapshot: EngineSnapshot): void {
    this.runId = snapshot.runId;
    this.config = snapshot.config;
    this.budgets = new Budgets(snapshot.config);
    this.budgets.restore(snapshot.budgets);
    this.stats = new StatsCollector(snapshot.config, this.deps.clock.now());
    this.frontier.restore(snapshot.frontier);
    this.sessionSeen = new Set(snapshot.sessionSeen);
    this.currentSeedId = snapshot.currentSeedId;
    this.currentDepth = snapshot.currentDepth;
    this.seedScans = new Map(Object.entries(snapshot.seedScans ?? {}));
    this.seededQueries = new Set(snapshot.seededQueries ?? []);
    this.nextSeedIndex = snapshot.nextSeedIndex ?? 0;
    this.expansionsSinceSeed = snapshot.expansionsSinceSeed ?? 0;
    /*
     * Devam ederken kanal listesi geri yükleniyor. Aksi hâlde yarıda kalan bir
     * kanal modu taraması, zaten yakaladığı kanalları yeniden değerlendirir ve
     * bu sefer BAŞKA bir temsilci videoyla ikinci bir kart üretirdi — kullanıcı
     * aynı kanalı havuzda iki kez görürdü.
     */
    this.evaluatedChannels = new Set(snapshot.evaluatedChannels ?? []);
    this.aboutFailedChannels.clear();
  }

  // ---------------------------------------------------------------- döngü

  private async runLoop(): Promise<StopReason> {
    for (;;) {
      if (this.stopRequested !== null) break;

      if (this.pauseRequested) {
        await this.waitWhilePaused();
        continue;
      }

      if (this.state.phase === 'cooldown') {
        await this.waitOutCooldown();
        continue;
      }

      const exhausted = this.budgets?.exhausted() ?? null;
      if (exhausted !== null) {
        this.stopRequested = exhausted;
        continue;
      }

      try {
        if (this.frontier.size === 0 || this.shouldRefreshSeed()) await this.seed();
        else await this.expandNext();
      } catch (error) {
        this.handleLoopError(error);
      }

      this.emit({ type: 'stats_tick', stats: this.statsSnapshot() });
    }

    return this.finish();
  }

  private handleLoopError(error: unknown): void {
    if (isGatewayError(error)) {
      if (error.kind === 'login_required') this.stats?.recordThrottleSignal('login_required');
      if (error.kind === 'throttled_soft') this.stats?.recordThrottleSignal('http429');
      const trip = this.detector.recordError(error.kind);
      if (trip !== null) this.enterCooldown(trip);
      return;
    }
    // Ağ dışı bir hata programlama hatasıdır: sessizce yutmak, saatlerce boş
    // dönen bir tarama üretir.
    const message = error instanceof Error ? error.message : String(error);
    this.emit({ type: 'engine_error', message, fatal: true });
    this.stopRequested = 'fatal_error';
  }

  private finish(): StopReason {
    const reason = this.stopRequested ?? 'completed';
    this.transition({ phase: 'stopping' });
    this.transition({ phase: 'stopped', reason });
    return reason;
  }

  private async waitWhilePaused(): Promise<void> {
    if (this.state.phase === 'cooldown') {
      this.suspendedCooldown = {
        until: this.state.until,
        level: this.state.level,
        prior: this.state.prior,
      };
    }
    const prior: ResumablePhase =
      this.state.phase === 'crawling'
        ? 'crawling'
        : this.state.phase === 'cooldown'
          ? this.state.prior
          : 'seeding';

    this.transition({ phase: 'paused', prior });

    while (this.pauseRequested && this.stopRequested === null) {
      this.pauseGate = deferred();
      await this.pauseGate.promise;
      this.pauseGate = null;
    }

    if (this.stopRequested !== null) return;

    // Duraklatıp devam ederek cooldown'dan kaçılamaz: ceza süresi korunur.
    const suspended = this.suspendedCooldown;
    if (suspended !== null && suspended.until > this.deps.clock.now()) {
      this.transition({ phase: 'cooldown', ...suspended });
      return;
    }
    this.suspendedCooldown = null;
    this.transition(
      prior === 'crawling' ? { phase: 'crawling' } : { phase: 'seeding', attempt: 0 },
    );
  }

  private async waitOutCooldown(): Promise<void> {
    if (this.state.phase !== 'cooldown') return;
    const { until, prior } = this.state;
    const remaining = until - this.deps.clock.now();
    if (remaining > 0) await this.deps.sleeper.sleep(remaining, this.abort.signal);
    if (this.stopRequested !== null || this.pauseRequested) return;
    this.suspendedCooldown = null;
    this.transition(
      prior === 'crawling' ? { phase: 'crawling' } : { phase: 'seeding', attempt: 0 },
    );
  }

  private enterCooldown(trip: ThrottleTrip): void {
    const prior: ResumablePhase = this.state.phase === 'crawling' ? 'crawling' : 'seeding';
    const until = this.deps.clock.now() + trip.cooldownMs;
    this.emit({ type: 'cooldown_started', until, cause: trip.cause, level: trip.level });
    this.transition({ phase: 'cooldown', until, level: trip.level, prior });
  }

  // -------------------------------------------------------------- tohumlama

  private shouldRefreshSeed(): boolean {
    const config = this.requireConfig();
    const hasUnseededQuery = config.seedQueries.some((query) => !this.seededQueries.has(query));
    // Kanal radarının asıl veri kaynağı sıralı aramadır. Öneri grafı eski ve
    // büyük kanallara kaydığı için ancak bütün bağımsız sorgular tüketilince açılır.
    if (config.mode === 'channel') return hasUnseededQuery;
    return this.expansionsSinceSeed >= SEED_REFRESH_EXPANSIONS && hasUnseededQuery;
  }

  private async seed(): Promise<void> {
    const config = this.requireConfig();
    this.seedAttempts += 1;
    this.transition({ phase: 'seeding', attempt: this.seedAttempts });

    const manual = this.manualSeeds.shift();
    if (manual !== undefined) {
      this.frontier.add({
        videoId: manual,
        depth: 0,
        vpd: null,
        parentVideoId: null,
        seedKey: `manual:${manual}`,
        seedVideoId: manual,
        seedQuery: null,
        topicMisses: 0,
      });
      this.currentSeedId = manual;
      this.expansionsSinceSeed = 0;
      this.seedAttempts = 0;
      this.emit({ type: 'seed_acquired', videoId: manual, title: '', manual: true });
      this.transition({ phase: 'crawling' });
      return;
    }

    const source = await this.fetchSeedCards(config);
    const cards = source.cards;

    const usable: RawVideoCard[] = [];
    for (const card of cards) {
      if (card.kind !== 'video') continue;
      if (this.sessionSeen.has(card.videoId)) continue;
      if (await this.deps.seen.has(card.videoId)) continue;
      usable.push(card);
    }

    if (usable.length === 0) {
      // Periyodik ek tohum aramasında bütün kartlar zaten görülmüş olabilir.
      // Mevcut frontier varken bu bir feed arızası değildir ve çalışan kolu
      // ölümcül hatayla kesmemelidir.
      if (this.frontier.size > 0 && cards.some((card) => card.kind === 'video')) {
        this.seedAttempts = 0;
        this.expansionsSinceSeed = 0;
        this.transition({ phase: 'crawling' });
        return;
      }
      this.stats?.recordThrottleSignal('empty_feed');
      const trip = this.detector.recordEmptyFeed();
      if (trip !== null) {
        this.enterCooldown(trip);
        return;
      }
      if (this.seedAttempts >= MAX_SEED_ATTEMPTS) {
        this.emit({
          type: 'engine_error',
          message: 'Ana sayfa üst üste kullanılabilir tohum vermedi',
          fatal: true,
        });
        this.stopRequested = 'fatal_error';
      }
      return;
    }

    this.detector.recordSuccess();
    this.seedAttempts = 0;

    if (config.mode === 'channel' && source.query !== null) {
      await this.evaluateChannelSearchSeeds(usable, source.query);
    }

    const [seed, ...rest] = chooseSeeds(usable, config, this.deps.rng);
    if (seed === undefined) return;

    this.currentSeedId = seed.videoId;
    this.currentDepth = 0;
    const seedKey = source.query === null ? `home:${seed.videoId}` : `query:${source.query}`;
    for (const card of [seed, ...rest]) {
      this.frontier.add({
        videoId: card.videoId,
        depth: 0,
        vpd: vpdOf(card),
        parentVideoId: null,
        seedKey,
        seedVideoId: seed.videoId,
        seedQuery: source.query,
        topicMisses: 0,
      });
      // Tohum kullanıldı sayılır: kuyruk boşaldığında ana sayfa aynı videoyu
      // sonsuza dek yeniden tohumlamasın.
      this.sessionSeen.add(card.videoId);
    }
    this.stats?.recordEnqueue(1 + rest.length);
    this.expansionsSinceSeed = 0;
    this.emit({ type: 'seed_acquired', videoId: seed.videoId, title: seed.title, manual: false });
    this.transition({ phase: 'crawling' });
  }

  /** Kanal radarında arama sonucu yalnızca yürüme tohumu değil, doğrudan adaydır. */
  private async evaluateChannelSearchSeeds(cards: RawVideoCard[], query: string): Promise<void> {
    const config = this.requireConfig();
    const seedKey = `query:${query}`;

    for (const card of cards) {
      if (this.stopRequested !== null || this.pauseRequested) return;
      if (this.budgets?.exhausted() !== null) return;

      this.budgets?.recordScan();
      this.seedScans.set(seedKey, (this.seedScans.get(seedKey) ?? 0) + 1);

      const topic = checkTopic(
        card.title,
        card.channelName,
        config.topicIncludeTerms,
        config.topicExcludeTerms,
      );
      if (topic.verdict !== 'accepted') {
        this.rejectCard(
          card,
          'shape',
          topic.verdict === 'excluded' ? 'topic_excluded' : 'topic_mismatch',
        );
        this.sessionSeen.add(card.videoId);
        continue;
      }

      await this.evaluateCard(card, 0, {
        seedKey,
        seedVideoId: card.videoId,
        seedQuery: query,
        topicMisses: 0,
        topicScore: topic.score,
        topicMatches: topic.matchedTerms,
      });
      this.sessionSeen.add(card.videoId);
    }
  }

  /**
   * Tohum kartlarını getirir.
   *
   * Ana sayfa önce denenir ama anonim oturumda genellikle video yerine
   * "giriş yap" kartı döner (canlı testte doğrulandı). Bir kez boş dönerse bir
   * daha denenmez ve arama tohumlarına geçilir — her tohumlamada boşa bir
   * istek harcamanın anlamı yok.
   */
  private async fetchSeedCards(
    config: CrawlConfig,
  ): Promise<{ cards: RawVideoCard[]; query: string | null }> {
    // Kanal radarı belirli format kümelerini arıyor. Kişiselleşmiş ana sayfa
    // bu niyeti taşımaz ve canlı ölçümde eski, yüz odaklı kanallara sürükledi.
    if (config.mode === 'channel') this.homeFeedExhausted = true;

    if (!this.homeFeedExhausted) {
      const home = await this.deps.gateway.fetchHomeFeed(this.abort.signal);
      this.budgets?.recordClassA();
      if (home.some((card) => card.kind === 'video')) return { cards: home, query: null };

      this.homeFeedExhausted = true;
      this.emit({
        type: 'engine_error',
        message: 'Ana sayfa anonim oturumda video vermiyor — arama tohumlarına geçildi',
        fatal: false,
      });
    }

    const query = this.nextSeedQuery(config.seedQueries);
    if (query === null) return { cards: [], query: null };
    this.seededQueries.add(query);
    const results = await this.deps.gateway.fetchSearchFeed(
      query,
      this.abort.signal,
      config.searchFilter,
    );
    this.budgets?.recordClassA();
    return { cards: results, query };
  }

  private nextSeedQuery(queries: readonly string[]): string | null {
    if (queries.length === 0) return null;
    for (let offset = 0; offset < queries.length; offset += 1) {
      const index = (this.nextSeedIndex + offset) % queries.length;
      const query = queries[index];
      if (query !== undefined && !this.seededQueries.has(query)) {
        this.nextSeedIndex = (index + 1) % queries.length;
        return query;
      }
    }
    const query = queries[this.nextSeedIndex % queries.length] ?? null;
    this.nextSeedIndex = (this.nextSeedIndex + 1) % queries.length;
    return query;
  }

  // ------------------------------------------------------------- genişletme

  private async expandNext(): Promise<void> {
    const config = this.requireConfig();
    const node = pickNext(this.frontier, config.epsilon, this.deps.rng, this.seedScans);
    if (node === null) return;
    this.frontier.remove(node.videoId);
    this.expansionsSinceSeed += 1;

    if (node.depth !== this.currentDepth) {
      this.currentDepth = node.depth;
      this.emit({ type: 'depth_changed', depth: node.depth, maxDepth: config.maxDepth });
    }

    const page = await this.deps.gateway.fetchWatchNext(node.videoId, this.abort.signal);
    this.budgets?.recordClassB();
    this.stats?.recordExpansion();

    if (page.cards.length === 0) {
      this.stats?.recordThrottleSignal('empty_feed');
      const trip = this.detector.recordEmptyFeed();
      if (trip !== null) this.enterCooldown(trip);
      return;
    }
    this.detector.recordSuccess();

    this.emit({
      type: 'node_expanded',
      videoId: node.videoId,
      depth: node.depth,
      cardCount: page.cards.length,
    });

    const childDepth = node.depth + 1;
    const explorable: Array<{ card: RawVideoCard; topicMisses: number }> = [];

    for (const card of page.cards) {
      if (this.stopRequested !== null) return;
      /*
       * Duraklama kart aralarında da kontrol ediliyor.
       *
       * Önceden yalnızca döngünün başında bakılıyordu; ama bir tur = bir
       * düğüm genişletmesi ve bu, hız sınırı yüzünden 8+ istek × ~2,2 sn
       * sürebiliyor. Kullanıcı "Duraklat"a basıp 40 saniye hiçbir şey
       * olmadığını görünce butonu bozuk sanıyordu. `break` kullanıyoruz ki
       * o ana kadar toplanan komşular yine de kuyruğa girsin.
       */
      if (this.pauseRequested) break;
      if (this.sessionSeen.has(card.videoId)) continue;

      this.budgets?.recordScan();
      this.seedScans.set(node.seedKey, (this.seedScans.get(node.seedKey) ?? 0) + 1);

      const topic = checkTopic(
        card.title,
        card.channelName,
        config.topicIncludeTerms,
        config.topicExcludeTerms,
      );
      if (topic.verdict !== 'accepted') {
        const reason: SkipReason =
          topic.verdict === 'excluded' ? 'topic_excluded' : 'topic_mismatch';
        this.stats?.recordReject(reason);
        this.emit({
          type: 'video_skipped',
          videoId: card.videoId,
          title: card.title,
          stage: 'shape',
          reason,
          metrics: {
            views: card.viewsApprox,
            ageDays: card.publishedAgeDays,
            vpd: vpdOf(card),
            channelId: card.channelId,
          },
        });
        this.sessionSeen.add(card.videoId);

        const misses = node.topicMisses + 1;
        const languageAccepted =
          checkLanguage(
            card.title,
            config.crawlLanguages,
            config.allowUnknownLanguage,
            card.channelName,
          ) === 'accepted';
        if (
          topic.verdict === 'mismatch' &&
          misses <= topicDriftLimit(config.topicStrictness) &&
          languageAccepted &&
          card.kind === 'video'
        ) {
          explorable.push({ card, topicMisses: misses });
        }
        continue;
      }

      const context: WalkContext = {
        seedKey: node.seedKey,
        seedVideoId: node.seedVideoId,
        seedQuery: node.seedQuery,
        topicMisses: 0,
        topicScore: topic.score,
        topicMatches: topic.matchedTerms,
      };
      const outcome = await this.evaluateCard(card, childDepth, context);
      this.sessionSeen.add(card.videoId);

      if (outcome === 'enqueue') {
        if (childDepth <= config.maxDepth) {
          const added = this.frontier.add({
            videoId: card.videoId,
            depth: childDepth,
            vpd: vpdOf(card),
            parentVideoId: node.videoId,
            seedKey: node.seedKey,
            seedVideoId: node.seedVideoId,
            seedQuery: node.seedQuery,
            topicMisses: 0,
          });
          if (added) this.stats?.recordEnqueue();
        }
      } else if (outcome === 'explorable') {
        explorable.push({ card, topicMisses: 0 });
      }
    }

    // Sıradan videolardan da birkaçına dallan ki graf gezilebilir kalsın.
    if (childDepth <= config.maxDepth) {
      for (const item of sample(explorable, EXPLORATION_SAMPLE_SIZE, this.deps.rng)) {
        const { card } = item;
        const added = this.frontier.add({
          videoId: card.videoId,
          depth: childDepth,
          vpd: vpdOf(card),
          parentVideoId: node.videoId,
          seedKey: node.seedKey,
          seedVideoId: node.seedVideoId,
          seedQuery: node.seedQuery,
          topicMisses: item.topicMisses,
        });
        if (added) this.stats?.recordEnqueue();
      }
    }

    await this.maybePersistSnapshot();
  }

  private async evaluateCard(
    card: RawVideoCard,
    depth: number,
    context: WalkContext,
  ): Promise<'enqueue' | 'explorable' | 'drop'> {
    const config = this.requireConfig();

    /*
     * YÜRÜYÜŞ KAPISI — pipeline'dan ÖNCE ve ondan bağımsız.
     *
     * Burada, çünkü bu bir SKOR filtresi değil bir YÜRÜYÜŞ politikası: soru
     * "bu video iyi mi" değil, "bu kenardan yürüyelim mi". Pipeline'a konsaydı
     * eleme sebebi `prefilter` olur ve kart yine `explorable` sayılıp keşif
     * örneklemine girerdi — yani tam da engellemek istediğimiz şey olurdu.
     *
     * Bedava: başlık zaten kartta, hiçbir istek harcanmıyor.
     */
    const languageVerdict = checkLanguage(
      card.title,
      config.crawlLanguages,
      config.allowUnknownLanguage,
      // Başlık dil sinyali taşımadığında kanal adı devreye giriyor; ölçümde
      // kartların %37.7'si yalnızca başlıkla ayırt edilemiyordu.
      card.channelName,
    );
    if (languageVerdict !== 'accepted') {
      const reason: SkipReason =
        languageVerdict === 'unknown' ? 'language_unknown' : 'language_mismatch';
      this.stats?.recordReject(reason);
      this.emit({
        type: 'video_skipped',
        videoId: card.videoId,
        title: card.title,
        stage: 'shape',
        reason,
        metrics: {
          views: card.viewsApprox,
          ageDays: card.publishedAgeDays,
          vpd: vpdOf(card),
          channelId: card.channelId,
        },
      });
      return 'drop';
    }

    /*
     * Kanal modu buradan ayrılıyor — `seen` kontrolünden ÖNCE.
     *
     * Sebep: bu kartın daha önce yakalanmış olması KANAL hakkında bir şey
     * söylemiyor. Kanal modunda "görüldü" kavramı yürünen karta değil, kanalı
     * temsil eden videoya ait; o kontrol temsilci seçilirken yapılıyor.
     */
    if (config.mode === 'channel') return this.evaluateChannelMode(card, depth, context);

    // Havuzdaki (ya da çöpe atılmış) bir video yeniden skorlanmaz — ama graf
    // düğümü olarak hâlâ geçerlidir, üstünden yürümeye devam edebiliriz.
    if (await this.deps.seen.has(card.videoId)) {
      this.stats?.recordReject('seen');
      this.emit({
        type: 'video_skipped',
        videoId: card.videoId,
        title: card.title,
        stage: 'shape',
        reason: 'seen',
        metrics: {
          views: card.viewsApprox,
          ageDays: card.publishedAgeDays,
          vpd: vpdOf(card),
          channelId: card.channelId,
        },
      });
      return card.kind === 'video' ? 'explorable' : 'drop';
    }

    const result = await runPipeline(card, {
      config,
      isSeen: () => false,
      resolveChannel: (channelId) => this.resolveChannel(channelId),
      resolveCountry: async (channelId, snapshot) =>
        // Anlık görüntü ülkeyi zaten taşıyorsa ek istek yok.
        snapshot.country ??
        (
          await this.resolveAbout(channelId, {
            country: true,
            joinedAt: false,
          })
        ).country,
    });

    if (result.kind === 'matched') {
      this.emit({ type: 'video_scanned', card, depth });
      const match = this.buildMatch(
        result.candidate,
        result.score,
        result.snapshot,
        depth,
        context,
      );
      this.stats?.recordMatch();
      await this.deps.seen.add(card.videoId, this.runId ?? '');
      this.emit({ type: 'video_matched', match });
      return 'enqueue';
    }

    if (result.candidate !== null) {
      // Ücretsiz kapıları geçmişti: arayüzde bekleyen kart göründü, geri çekilecek.
      this.emit({ type: 'video_scanned', card, depth });
    }
    this.stats?.recordReject(result.reason);
    this.emit({
      type: 'video_skipped',
      videoId: card.videoId,
      title: card.title,
      stage: result.stage,
      reason: result.reason,
      metrics: {
        views: card.viewsApprox,
        ageDays: card.publishedAgeDays,
        vpd: vpdOf(card),
        channelId: card.channelId,
        score: result.score,
      },
    });

    if (result.candidate !== null) return 'enqueue';
    // Gerçek yatay video ama outlier değil: keşif için örneklenebilir.
    return result.stage === 'prefilter' && card.kind === 'video' ? 'explorable' : 'drop';
  }

  /**
   * Kanal avı: bulunan şey video değil KANAL.
   *
   * Video modundan farkı kabul biriminde: orada "bu video kendi kanalının kaç
   * katı", burada "bu kanalın videolarının kaçı tutuyor". İkisi ayrı olmak
   * zorunda — her videosu tutan bir kanalın medyanı zaten yüksektir, dolayısıyla
   * hiçbir videosu sivrilmez ve video modunda yapısal olarak görünmez.
   *
   * Pipeline'a değil buraya yazıldı: `runPipeline` video başına karar veriyor ve
   * eleme sebebini `prefilter`/`score` aşamalarına bağlıyor. Kanal kararını
   * oraya sıkıştırmak, saf ve iyi test edilmiş bir zinciri iki farklı iş yapar
   * hâle getirirdi.
   */
  private async evaluateChannelMode(
    card: RawVideoCard,
    depth: number,
    context: WalkContext,
  ): Promise<'enqueue' | 'explorable' | 'drop'> {
    const config = this.requireConfig();

    // Ücretsiz kapılar yürüyüş filtresi olarak kalıyor: kanal isteği bütçesini
    // koruyan asıl şey bunlar (özellikle izlenme tavanı).
    const free = evaluateFreeGates(card, config, () => false);
    if (free.kind === 'skip') return this.rejectCard(card, free.stage, free.reason);

    const channelId = card.channelId;
    if (channelId === null) return 'explorable';

    /*
     * Aynı kanal bir taramada bir kez değerlendirilir.
     *
     * Öneri grafı aynı kanalın videolarını ısrarla gösteriyor; her biri için
     * skoru yeniden hesaplamak boşa iş, yakalamayı tekrarlamak ise havuzu aynı
     * kanalla doldururdu — oysa kullanıcının istediği kanal başına TEK kart.
     * Kart yine de kuyruğa giriyor: yükselen bir kanalın komşuları iyi kenarlar.
     */
    if (this.evaluatedChannels.has(channelId)) return 'enqueue';

    /*
     * Önceki bir taramada yakalanmış kanal yeniden değerlendirilmez — kanal
     * isteği de harcanmaz. Kart kuyruğa girer: komşuları hâlâ iyi kenarlar.
     */
    if (await this.deps.seen.hasChannel(channelId)) {
      this.evaluatedChannels.add(channelId);
      return 'enqueue';
    }

    const resolution = await this.resolveChannel(channelId);
    if (resolution.kind === 'budget_exhausted') {
      return this.rejectCard(card, 'channel_fetch', 'channel_budget_exhausted');
    }
    if (resolution.kind === 'rejected') {
      this.evaluatedChannels.add(channelId);
      return this.rejectCard(card, 'channel_cache', resolution.reason);
    }

    const snapshot = resolution.snapshot;
    const subsSkip = gateSubscriberRange(snapshot, config);
    if (subsSkip !== null) {
      this.evaluatedChannels.add(channelId);
      return this.rejectCard(card, subsSkip.stage, subsSkip.reason);
    }

    // Buradan sonrası BEDAVA: yüklemeler anlık görüntüyle zaten geldi.
    const outcome = scoreChannel(snapshot, config);
    if (outcome.kind === 'insufficient') {
      this.evaluatedChannels.add(channelId);
      return this.rejectCard(card, 'score', outcome.reason);
    }
    const score = outcome.score;
    /*
     * İzlenme kapısı MEDYANA uygulanıyor, maksimuma değil. Tek videosu patlamış
     * bir kanal maksimumla geçerdi; medyanla geçemez. "İstikrarlı biçimde çok
     * izleniyor" fikri böylece ayrı bir istikrar eşiğine gerek kalmadan tek
     * sayının içinde duruyor.
     */
    if (score.medianViews < config.minChannelMedianViews) {
      this.evaluatedChannels.add(channelId);
      return this.rejectCard(card, 'score', 'channel_views_low');
    }

    /*
     * Yaş kapısı en sonda — TEK ek istek burada harcanıyor ve yalnızca istikrar
     * eşiğini geçmiş kanallar için. Ülke filtresiyle aynı desen; iki bilgi de
     * aynı yanıttan geldiği için ülke kapısı ek maliyet getirmiyor.
     */
    const about = await this.resolveAbout(channelId, {
      country: countryFilterActive(config.countries),
      joinedAt: true,
    });
    this.evaluatedChannels.add(channelId);

    const ageReasons: LowConfidenceReason[] = [];
    let channelAgeDays: number | null = null;
    if (about.joinedAtMs === null) {
      if (!config.allowUnknownChannelAge) {
        return this.rejectCard(card, 'score', 'channel_age_unknown');
      }
      ageReasons.push('age_unknown');
    } else {
      channelAgeDays = (this.deps.clock.now() - about.joinedAtMs) / DAY;
      /*
       * Karar HER SEFERİNDE config'ten türetiliyor, verdikte yazılmıyor.
       * Verdikt kalıcı saklanıyor; yaş oraya girseydi kullanıcı eşiği
       * gevşettiğinde eski karar yapışır ve filtre işe yaramaz olurdu.
       */
      if (channelAgeDays > config.maxChannelAgeDays) {
        return this.rejectCard(card, 'score', 'channel_too_old');
      }
    }

    if (countryFilterActive(config.countries)) {
      const verdict = checkCountry(about.country, config.countries, config.allowUnknownCountry);
      if (verdict !== 'accepted') {
        return this.rejectCard(
          card,
          'score',
          verdict === 'unknown' ? 'country_unknown' : 'country_mismatch',
        );
      }
    }

    // Temsilci: en çok izlenen ama HENÜZ YAKALANMAMIŞ video. Hepsi görüldüyse
    // kanal zaten havuzda demektir.
    let representative: RawVideoCard | null = null;
    for (const candidate of score.representatives) {
      if (!(await this.deps.seen.has(candidate.videoId))) {
        representative = candidate;
        break;
      }
    }
    if (representative === null) return this.rejectCard(card, 'shape', 'seen');

    /*
     * `video_scanned` YÜRÜNEN kartla değil TEMSİLCİYLE yayımlanıyor.
     *
     * Arayüzdeki akış "önce bekleyen kart, sonra skor" üzerine kurulu ve
     * `pool:update` olayı `video_matched`'in videoId'siyle eşleşiyor. Yürünen
     * kart için bekleyen kart açsaydık, güncelleme başka bir kimliğe gider ve
     * havuzda hiç dolmayan hayalet kartlar kalırdı.
     */
    this.emit({ type: 'video_scanned', card: representative, depth });
    const match = this.buildChannelMatch(representative, score, snapshot, {
      depth,
      channelAgeDays,
      extraReasons: ageReasons,
      walk: context,
    });
    this.stats?.recordMatch();
    await this.deps.seen.add(representative.videoId, this.runId ?? '');
    await this.deps.seen.addChannel(channelId);
    this.emit({ type: 'video_matched', match });
    return 'enqueue';
  }

  /** Eleme olayını yayımlar ve kartın graf yürüyüşündeki kaderini belirler. */
  private rejectCard(
    card: RawVideoCard,
    stage: GateName,
    reason: SkipReason,
  ): 'explorable' | 'drop' {
    this.stats?.recordReject(reason);
    this.emit({
      type: 'video_skipped',
      videoId: card.videoId,
      title: card.title,
      stage,
      reason,
      metrics: {
        views: card.viewsApprox,
        ageDays: card.publishedAgeDays,
        vpd: vpdOf(card),
        channelId: card.channelId,
      },
    });
    // Elenen kanal kötü bir GRAF DÜĞÜMÜ değil: gerçek bir yatay videoysa
    // üstünden yürümeye devam edebiliriz.
    return card.kind === 'video' ? 'explorable' : 'drop';
  }

  private buildChannelMatch(
    representative: RawVideoCard,
    score: ChannelScore,
    snapshot: ChannelSnapshot,
    context: {
      depth: number;
      channelAgeDays: number | null;
      extraReasons: LowConfidenceReason[];
      walk: WalkContext;
    },
  ): Match {
    const views = representative.viewsApprox ?? 0;
    const ageDays = representative.publishedAgeDays ?? 0;
    const reasons = [...score.lowConfidenceReasons, ...context.extraReasons];

    return {
      videoId: representative.videoId,
      runId: this.runId ?? '',
      channelId: snapshot.channelId,
      title: representative.title,
      thumbnailUrl: representative.thumbnailUrl,
      durationSec: representative.durationSec ?? 0,
      views,
      vpd: viewsPerDay(views, ageDays),
      projectedViews: projectViews(views, ageDays),
      publishedAgeDays: ageDays,
      scoreType: 'channel',
      hype: null,
      // Kanal çarpanı `vsr` kolonunu paylaşıyor (bkz. schema.ts); ayrımı
      // `scoreType` yapıyor.
      vsr: channelScoreValue(score),
      z: null,
      // Makbuzun payı ve paydası: "son n videonun medyanı".
      baselineMedian: score.medianViews > 0 ? score.medianViews : null,
      baselineN: score.n,
      lowConfidence: reasons.length > 0,
      lowConfidenceReasons: reasons,
      channelHitRate: score.hitRate,
      channelAgeDays: context.channelAgeDays,
      channelIsHot:
        snapshot.subsApprox !== null && snapshot.subsApprox > 0
          ? score.medianViews > snapshot.subsApprox
          : false,
      suspectedBoughtTraffic: false,
      channelName: snapshot.name,
      subsApprox: snapshot.subsApprox,
      subsText: snapshot.subsText,
      subsHidden: snapshot.subsHidden,
      depth: context.depth,
      seedVideoId: context.walk.seedVideoId,
      seedQuery: context.walk.seedQuery,
      topicScore: context.walk.topicScore,
      topicMatches: context.walk.topicMatches,
      caughtAt: this.deps.clock.now(),
    };
  }

  private buildMatch(
    candidate: Candidate,
    score: ScoredResult,
    snapshot: ChannelSnapshot,
    depth: number,
    context: WalkContext,
  ): Match {
    const match: Match = {
      videoId: candidate.videoId,
      runId: this.runId ?? '',
      channelId: candidate.channelId,
      title: candidate.title,
      thumbnailUrl: candidate.thumbnailUrl,
      durationSec: candidate.durationSec,
      views: candidate.views,
      vpd: candidate.vpd,
      projectedViews: score.projectedViews,
      publishedAgeDays: candidate.ageDays,
      scoreType: score.scoreType,
      hype: score.hype,
      vsr: score.vsr,
      z: score.z,
      baselineMedian: score.baselineMedian,
      baselineN: score.baselineN,
      lowConfidence: score.lowConfidence,
      lowConfidenceReasons: score.lowConfidenceReasons,
      // Kanal modu alanları video modunda boş kalır.
      channelHitRate: null,
      channelAgeDays: null,
      channelIsHot: score.channelIsHot,
      // Beğeni oranı yalnızca export zenginleştirmesinde bilinir.
      suspectedBoughtTraffic: false,
      channelName: snapshot.name,
      subsApprox: snapshot.subsApprox,
      subsText: snapshot.subsText,
      subsHidden: snapshot.subsHidden,
      depth,
      seedVideoId: context.seedVideoId,
      seedQuery: context.seedQuery,
      topicScore: context.topicScore,
      topicMatches: context.topicMatches,
      caughtAt: this.deps.clock.now(),
    };
    return match;
  }

  // ------------------------------------------------------- kanal çözümleme

  private async resolveChannel(channelId: string): Promise<ChannelResolution> {
    const config = this.requireConfig();
    const now = this.deps.clock.now();
    const cached = await this.deps.channels.get(channelId);

    if (cached !== null) {
      const verdictLive = cached.verdictExpiresAt === null || cached.verdictExpiresAt > now;
      if (verdictLive) {
        // Verdikt GEÇMİŞ bir yapılandırmayla verilmiş olabilir. Kullanıcı abone
        // sınırını gevşettiyse eski "aralık dışı" kararını uygulamak, kapatılan
        // filtrenin hiç işe yaramaması demek olurdu — saklanan abone sayısıyla
        // yeniden karar veriyoruz.
        const stillRejected =
          cached.verdict === 'unavailable' ||
          subscribersOutOfRange(cached.subsApprox, config) ||
          (cached.subsApprox === null && cached.verdict !== 'in_range');

        const rejection = stillRejected ? rejectionFor(cached.verdict) : null;
        if (rejection !== null) {
          this.stats?.recordChannelNegativeHit();
          return { kind: 'rejected', reason: rejection };
        }
      }
      if (
        cached.snapshot !== null &&
        cached.snapshotFetchedAt !== null &&
        now - cached.snapshotFetchedAt < CHANNEL_SNAPSHOT_TTL_MS
      ) {
        this.stats?.recordChannelCacheHit();
        this.emit({
          type: 'channel_resolved',
          channelId,
          cacheHit: true,
          subsApprox: cached.snapshot.subsApprox,
        });
        return { kind: 'snapshot', snapshot: cached.snapshot, cacheHit: true };
      }
    }

    if (this.budgets?.hasChannelBudget() !== true) return { kind: 'budget_exhausted' };

    let snapshot: ChannelSnapshot;
    try {
      snapshot = await this.deps.gateway.fetchChannelSnapshot(channelId, this.abort.signal);
    } catch (error) {
      // Kısıtlama sinyali kimliğin sorunudur: döngüye kadar yükselir.
      if (isGatewayError(error) && isThrottleSignal(error.kind)) throw error;
      await this.deps.channels.putVerdict(
        channelId,
        'unavailable',
        now + UNAVAILABLE_VERDICT_TTL_MS,
      );
      return { kind: 'rejected', reason: 'channel_unavailable' };
    }

    this.budgets?.recordChannelFetch();
    this.stats?.recordChannelFetch();

    const verdict = classifyChannel(snapshot, config);
    const expiresAt =
      verdict === 'out_of_range'
        ? now + NEGATIVE_VERDICT_TTL_MS
        : null; /* in_range ve blocklisted süresizdir */
    await this.deps.channels.putSnapshot(snapshot, verdict, expiresAt, now);

    this.emit({
      type: 'channel_resolved',
      channelId,
      cacheHit: false,
      subsApprox: snapshot.subsApprox,
    });

    if (verdict === 'blocklisted') return { kind: 'rejected', reason: 'blocklisted' };
    // Aralık dışıysa bile anlık görüntüyü geçiriyoruz: eleme kararı tek yerden,
    // abone kapısından çıksın. Önbellek zaten ısındı.
    return { kind: 'snapshot', snapshot, cacheHit: false };
  }

  /**
   * Kanalın "Hakkında" verisi: ülke + kuruluş tarihi.
   *
   * İkisi de değişmeyen bilgiler, kanal başına bir kez sorulup kalıcı olarak
   * saklanıyor. Tek istek iki kapıyı birden besliyor — ülke filtresi bu isteği
   * zaten atıyordu, kanal modunun yaş bilgisi bu yüzden bedava geliyor.
   *
   * Yalnızca ihtiyaç duyulduğunda çağrılır: ne ülke filtresi ne kanal modu
   * açıksa hiç dokunulmaz.
   */
  private async resolveAbout(
    channelId: string,
    required: { country: boolean; joinedAt: boolean },
  ): Promise<ChannelAbout> {
    const cached = await this.deps.channels.get(channelId);
    const hasRequiredCountry = !required.country || cached?.country != null;
    const hasRequiredJoinedAt = !required.joinedAt || cached?.joinedAt != null;
    if (cached !== null && hasRequiredCountry && hasRequiredJoinedAt) {
      return { country: cached.country, joinedAtMs: cached.joinedAt };
    }

    /*
     * Aynı tarama içinde başarısız olan istek tekrarlanmaz. Kalıcı bir
     * "okunamadı" işareti BİLİNÇLİ olarak yok: YouTube arayüzünü düzelttiğinde
     * ya da ayrıştırıcımız güncellendiğinde kendiliğinden iyileşsin. Maliyeti
     * tarama başına kanal başına tek istek.
     */
    if (this.aboutFailedChannels.has(channelId)) return { country: null, joinedAtMs: null };

    try {
      const about = await this.deps.gateway.fetchChannelAbout(channelId, this.abort.signal);
      this.budgets?.recordClassA();
      await this.deps.channels.putAbout(channelId, about.country, about.joinedAtMs);
      const missingRequired =
        (required.country && about.country === null) ||
        (required.joinedAt && about.joinedAtMs === null);
      if (missingRequired) this.aboutFailedChannels.add(channelId);
      return about;
    } catch (error) {
      if (isGatewayError(error) && isThrottleSignal(error.kind)) throw error;
      // Öğrenilemedi: bilinmiyor say, kanalı bu yüzden kaybetme.
      this.aboutFailedChannels.add(channelId);
      return { country: null, joinedAtMs: null };
    }
  }

  // ------------------------------------------------------------- yardımcılar

  private async maybePersistSnapshot(): Promise<void> {
    const every = this.deps.snapshotEveryNExpansions ?? 25;
    this.expansionsSinceSnapshot += 1;
    if (this.expansionsSinceSnapshot < every) return;
    this.expansionsSinceSnapshot = 0;
    const snapshot = this.snapshot();
    if (snapshot !== null) await this.deps.persistSnapshot?.(snapshot);
  }

  private statsSnapshot() {
    const stats = this.stats;
    const budgets = this.budgets;
    const config = this.config;
    if (stats === null || budgets === null || config === null) {
      throw new Error('Tarama başlatılmadan istatistik istenemez');
    }
    return stats.snapshot({
      now: this.deps.clock.now(),
      frontierSize: this.frontier.size,
      depth: this.currentDepth,
      budgets,
    });
  }

  private requireConfig(): CrawlConfig {
    if (this.config === null) throw new Error('Tarama yapılandırması yok');
    return this.config;
  }

  private emit(event: DomainEvent): void {
    this.deps.bus.emit(this.runId, event);
  }

  private transition(next: EngineState, reason?: string): void {
    const from = this.state.phase;
    if (from === next.phase) {
      this.state = next;
      return;
    }
    if (!canTransition(from, next.phase)) throw new IllegalTransitionError(from, next.phase);
    this.state = next;
    this.emit({
      type: 'state_changed',
      from,
      to: next.phase,
      ...(reason === undefined ? {} : { reason }),
      ...(next.phase === 'cooldown' ? { cooldownUntil: next.until } : {}),
    });
  }
}

function isThrottleSignal(kind: string): boolean {
  return kind === 'throttled_soft' || kind === 'login_required';
}

function rejectionFor(verdict: ChannelVerdict) {
  switch (verdict) {
    case 'blocklisted':
      return 'blocklisted' as const;
    case 'out_of_range':
      return 'subs_out_of_range' as const;
    case 'unavailable':
      return 'channel_unavailable' as const;
    default:
      return null;
  }
}

function classifyChannel(snapshot: ChannelSnapshot, config: CrawlConfig): ChannelVerdict {
  const subs = snapshot.subsApprox;
  if (snapshot.subsHidden || !isFiniteNumber(subs)) return 'in_range';
  // Kara liste yalnızca kullanıcı bir üst sınır koyduysa anlamlı: "abone sayısı
  // önemsiz" diyen birine dev kanalları kalıcı olarak eledirmek yanlış olur.
  if (config.maxSubs !== null && subs > BLOCKLIST_SUBSCRIBER_THRESHOLD) return 'blocklisted';
  if (subscribersOutOfRange(subs, config)) return 'out_of_range';
  return 'in_range';
}

function vpdOf(card: RawVideoCard): number | null {
  if (!isFiniteNumber(card.viewsApprox) || !isFiniteNumber(card.publishedAgeDays)) return null;
  return viewsPerDay(card.viewsApprox, card.publishedAgeDays);
}

/**
 * Tohum seçimi: eşiği geçen en az ana-akım görünen kart. Ana sayfa büyük
 * kanallarla doludur; en düşük izlenmeli kartla başlamak taramayı en baştan
 * küçük kanalların olduğu bölgeye yaklaştırır.
 */
function chooseSeeds(
  cards: readonly RawVideoCard[],
  config: CrawlConfig,
  rng: Rng,
): RawVideoCard[] {
  const floor = config.minViews ?? 0;
  const scored = cards.filter((c) => isFiniteNumber(c.viewsApprox) && c.viewsApprox >= floor);
  const pool = scored.length > 0 ? scored : [...cards];
  pool.sort((a, b) => (a.viewsApprox ?? 0) - (b.viewsApprox ?? 0));

  const primary = pool[0];
  if (primary === undefined) return [];
  const backups = sample(pool.slice(1), SEED_BACKUP_COUNT, rng);
  return [primary, ...backups];
}

function sample<T>(items: readonly T[], count: number, rng: Rng): T[] {
  if (items.length <= count) return [...items];
  const pool = [...items];
  const picked: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const index = Math.min(Math.floor(rng.next() * pool.length), pool.length - 1);
    const [item] = pool.splice(index, 1);
    if (item !== undefined) picked.push(item);
  }
  return picked;
}
