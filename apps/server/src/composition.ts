import { CrawlerEngine, systemClock, systemRng, systemSleeper, TypedEventBus } from '@hype/core';
import {
  createPersistenceSubscriber,
  createSnapshotPersister,
  createStorage,
  type Storage,
} from '@hype/db';
import {
  createInnertubeAdapter,
  DEFAULT_PULSE_START,
  installParserTelemetry,
  PulseController,
  type PulseLimits,
  type PulseState,
} from '@hype/innertube';
import {
  type CrawlConfig,
  type DomainEvent,
  type EnginePhase,
  type ExportEnvelope,
  type FunnelStats,
  nextAutoRestartConfig,
  type SnapshotState,
  type StopReason,
} from '@hype/shared';
import { ulid } from 'ulid';
import { buildExportEnvelope } from './export-builder.js';
import { Broadcaster } from './ws/broadcaster.js';
import { DashboardStream } from './ws/stream.js';

export const APP_VERSION = '0.1.0';

/** Sunucunun ihtiyaç duyduğu asgari log yüzeyi — pino tipine bağlanmıyoruz. */
export interface AppLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface AppOptions {
  dbPath: string;
  logger: AppLogger;
  /** Sürekli taramada iki tur arası bekleme (varsayılan 60 sn). */
  autoRestartDelayMs?: number;
}

/** Bu sebeplerle biten tarama, `autoRestart` açıksa yeniden başlar. */
const AUTO_RESTART_REASONS: ReadonlySet<StopReason> = new Set<StopReason>([
  'max_videos',
  'budget_exhausted',
  'completed',
]);

/** Nabız durumunun kalıcı anahtarı — öğrenilen limit yeniden başlatmada kaybolmasın. */
const KV_PULSE_STATE = 'pulse_state';
/** Nabız ne sıklıkla atar. */
const PULSE_TICK_MS = 60_000;

/**
 * Nabzın başlangıç limitleri. Ortam değişkeni verilirse oradan başlar
 * (HYPE_HOURLY_CAP / HYPE_HOURLY_CAP_B); nabız yine de oradan ayarlar.
 */
function pulseStart(): PulseLimits {
  const read = (name: string, fallback: number) => {
    const value = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    hourlyTotalCap: read('HYPE_HOURLY_CAP', DEFAULT_PULSE_START.hourlyTotalCap),
    hourlyClassBCap: read('HYPE_HOURLY_CAP_B', DEFAULT_PULSE_START.hourlyClassBCap),
    intervalScale: DEFAULT_PULSE_START.intervalScale,
  };
}

/**
 * Kompozisyon kökü — elle yazılmış bağımlılık enjeksiyonu.
 *
 * DI çerçevesi yok: yedi nesnenin bağlandığı tek bir fonksiyonda çerçeve,
 * çözdüğünden fazla dolaylılık ekler. Sıra önemli — hız yöneticisi oturumdan,
 * oturum motordan önce kurulur.
 */
export class AppContext {
  readonly storage: Storage;
  readonly bus: TypedEventBus;
  readonly broadcaster: Broadcaster;
  readonly stream: DashboardStream;
  readonly engine: CrawlerEngine;
  private readonly adapter: ReturnType<typeof createInnertubeAdapter>;
  private running: Promise<unknown> | null = null;
  private activeRun: string | null = null;
  private cooldownUntil: number | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAt: number | null = null;
  private closing = false;
  private pulse: PulseController;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  /** Son istatistikteki uyarı sayaçları — artış = yeni uyarı. */
  private lastWarnCounts = { http429: 0, emptyFeeds: 0, loginRequired: 0 };
  /**
   * Son istatistik anlık görüntüsü bellekte tutulur. Veritabanına 25 tikte bir
   * yazıldığı için, sayfa yenilendiğinde oradan okumak huni şeridini birkaç
   * saniye boş bırakırdı.
   */
  private lastStats: FunnelStats | null = null;

  constructor(private readonly options: AppOptions) {
    this.storage = createStorage({ path: options.dbPath, appVersion: APP_VERSION });
    this.bus = new TypedEventBus(systemClock, (error) =>
      options.logger.error({ err: error }, 'olay abonesi hata verdi'),
    );
    this.broadcaster = new Broadcaster(ulid(), () => systemClock.now());
    this.stream = new DashboardStream(this.broadcaster, systemClock, (runId, lines) =>
      this.storage.logs.append(runId, lines),
    );

    this.adapter = createInnertubeAdapter({
      kv: this.storage.kv,
      clock: systemClock,
      sleeper: systemSleeper,
      rng: systemRng,
      governor: {
        hourlyTotalCap: pulseStart().hourlyTotalCap,
        hourlyClassBCap: pulseStart().hourlyClassBCap,
      },
    });

    // NABIZ: limitler sabit değil, YouTube'un tepkisine göre ayarlanıyor.
    this.pulse = new PulseController(() => systemClock.now(), { limits: pulseStart() });
    void this.restorePulse();
    this.pulseTimer = setInterval(() => this.pulseTick(), PULSE_TICK_MS);
    this.pulseTimer.unref?.();

    installParserTelemetry((warning) => {
      this.bus.emit(this.activeRun, {
        type: 'parser_warning',
        errorType: warning.errorType,
        className: warning.className,
      });
    });

    this.engine = new CrawlerEngine({
      gateway: this.adapter.gateway,
      channels: this.storage.channels,
      seen: this.storage.seen,
      clock: systemClock,
      sleeper: systemSleeper,
      rng: systemRng,
      bus: this.bus,
      persistSnapshot: createSnapshotPersister(this.storage),
    });

    this.bus.subscribe(createPersistenceSubscriber(this.storage));
    this.bus.subscribe((envelope) => this.stream.handle(envelope));
    this.bus.subscribe((envelope) => this.trackLiveState(envelope.event));
  }

  get phase(): EnginePhase {
    return this.engine.phase;
  }

  get activeRunId(): string | null {
    return this.activeRun;
  }

  get isBusy(): boolean {
    return this.phase !== 'idle' && this.phase !== 'stopped';
  }

  get governorStats() {
    return this.adapter.governor.stats;
  }

  /** Nabzın durumu: güncel limitler, ruh hâli (hızlanıyor/yavaşladı…) ve sebep. */
  get pulseState(): PulseState {
    return this.pulse.snapshot;
  }

  /** Sürekli taramada bir sonraki turun başlayacağı an; bekleyen tur yoksa null. */
  get autoRestartAt(): number | null {
    return this.restartAt;
  }

  startRun(config: CrawlConfig, presetId: number | null): string {
    if (this.isBusy) throw new RunConflictError();
    this.cancelAutoRestart();
    const runId = ulid();
    this.activeRun = runId;
    this.storage.runs.create(runId, config, presetId);
    // Bölge, İLK istekten önce kurulmalı: kullanıcının istediği tam olarak bu —
    // "ülke seçtiğimde YouTube'a atılan ilk ping o ülkeden olsun".
    this.adapter.session.setRegion(config.region);
    this.launch(this.engine.start(runId, config), runId, config, presetId);
    return runId;
  }

  /** Kesintiye uğramış taramayı sürdürür; anlık görüntü yoksa null döner. */
  resumeRun(runId: string): boolean {
    if (this.isBusy) throw new RunConflictError();
    const snapshot = this.storage.runs.loadSnapshot(runId);
    if (snapshot === null) return false;
    this.activeRun = runId;
    this.storage.runs.setStatus(runId, 'running');
    // Devam eden tarama da kendi bölgesinde sürmeli; atlanırsa tarama sessizce
    // yanlış bölgeye kayar ve bu fark edilmesi zor bir hata olur.
    this.adapter.session.setRegion(snapshot.config.region);
    this.launch(this.engine.resumeFrom(snapshot), runId, snapshot.config, null);
    return true;
  }

  /**
   * Açılışta kendiliğinden devam: sürekli tarama (`autoRestart`) açıkken
   * sunucu kapanıp açılırsa (bilgisayar uykusu, yeniden başlatma, kod
   * değişikliğiyle yeniden yükleme) kesilen tarama kaldığı yerden sürer.
   * 5 Kasım'da bu yoktu: tarama 43 kanal bulduktan sonra kesildi ve iki gün
   * boşta bekledi. Anlık görüntü yoksa aynı ayarla yeni tur açılır.
   */
  autoResumeOnStartup(delayMs = 15_000): string | null {
    const run = this.storage.runs.findResumable();
    if (run === null || !run.config.autoRestart) return null;
    // Yalnız EN SON tarama sürdürülür: anlık görüntüsü olmadığı için yerine
    // yeni tur açılmış eski bir kesik kayıt, sonraki açılışta dirilmemeli.
    if (this.storage.runs.list(1)[0]?.runId !== run.runId) return null;
    const timer = setTimeout(() => {
      if (this.closing || this.isBusy) return;
      try {
        const resumed = this.resumeRun(run.runId);
        if (!resumed) this.startRun(run.config, null);
        this.options.logger.info(
          { runId: run.runId, resumed },
          'sürekli tarama: kesilen tarama açılışta sürdürüldü',
        );
      } catch (error) {
        this.options.logger.error({ err: error }, 'sürekli tarama: açılışta sürdürülemedi');
      }
    }, delayMs);
    timer.unref?.();
    return run.runId;
  }

  pause(): void {
    this.engine.pause();
  }

  resume(): void {
    this.engine.resume();
  }

  /** Durdur: çalışan taramayı keser VE bekleyen sürekli tarama turunu iptal eder. */
  stop(): void {
    this.cancelAutoRestart();
    if (this.isBusy) this.engine.stop('manual');
  }

  cancelAutoRestart(): boolean {
    const had = this.restartTimer !== null;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restartAt = null;
    return had;
  }

  requestSeed(videoId: string): void {
    this.engine.requestSeed(videoId);
  }

  /** Tarama çalışmıyorsa en son biten taramanın kimliği. */
  private latestRunId(): string | null {
    return this.storage.runs.list(1)[0]?.runId ?? null;
  }

  /** Çalışan taramanın canlı sayaçları; başka bir tarama sorulursa null. */
  liveStatsFor(runId: string): FunnelStats | null {
    return this.activeRun === runId ? this.lastStats : null;
  }

  broadcastPoolRemoval(videoId: string, reason: 'discarded' | 'failed_gate'): void {
    if (this.activeRun === null) return;
    this.broadcaster.broadcast({ type: 'pool:remove', runId: this.activeRun, videoId, reason });
  }

  broadcastPoolRestore(videoId: string): void {
    const item = this.storage.videos.get(videoId);
    if (item === null) return;
    this.broadcaster.broadcast({ type: 'pool:add', runId: item.runId, item });
  }

  /** Export zarfını üretir; `enrich` tek pahalı istekle açıklama/tarih doldurur. */
  async buildExport(videoId: string, enrich: boolean): Promise<ExportEnvelope | null> {
    return buildExportEnvelope(
      {
        storage: this.storage,
        ...(enrich
          ? {
              enrich: async (id: string) => {
                const controller = new AbortController();
                const details = await this.adapter.gateway.fetchVideoDetails(id, controller.signal);
                return {
                  description: details.description,
                  publishedAt: details.publishedAt,
                  views: details.views,
                  likes: details.likes,
                };
              },
            }
          : {}),
      },
      videoId,
      systemClock.now(),
    );
  }

  /** WebSocket yeniden bağlanmasında gönderilen tam durum. */
  buildSnapshot(): SnapshotState {
    const runId = this.activeRun;
    const run = runId === null ? null : this.storage.runs.get(runId);

    return {
      epochId: this.broadcaster.epochId,
      seq: this.broadcaster.currentSeq,
      status: this.phase,
      activeRun:
        run === null
          ? null
          : {
              runId: run.runId,
              status: this.phase,
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              stopReason: run.stopReason,
            },
      cooldownUntil: this.cooldownUntil,
      // Bellekteki değer her zaman daha taze; veritabanı yalnızca yedek.
      stats: this.lastStats ?? run?.stats ?? null,
      /*
       * Havuz görünümü TARAMAYA ÖZEL.
       *
       * Kayıtların hepsi veritabanında duruyor (hiçbir şey silinmiyor) ama
       * ekranda yalnızca güncel taramanın sonuçları var. Birikmeli bir liste,
       * farklı filtre ayarlarıyla yakalanmış videoları yan yana getirip
       * "bu neden burada?" sorusunu doğuruyordu.
       */
      pool: this.storage.videos.listRunPool(runId ?? this.latestRunId() ?? ''),
      logTail: this.stream.logTail,
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.cancelAutoRestart();
    if (this.pulseTimer !== null) clearInterval(this.pulseTimer);
    const interrupted = this.isBusy ? this.activeRun : null;
    if (this.isBusy) this.stop();
    await this.running?.catch(() => undefined);

    /*
     * Sunucu kapanışı kullanıcının "Durdur"u DEĞİLDİR.
     *
     * İkisini aynı sebeple işaretlemek, kod değişikliğiyle yeniden başlayan bir
     * geliştirme sunucusunun taramayı kullanıcı iptal etmiş gibi göstermesine ve
     * "Devam et" seçeneğinin kaybolmasına yol açıyordu. Kesinti olarak işaretlemek
     * kaldığı yerden sürdürmeyi mümkün kılıyor.
     */
    if (interrupted !== null) {
      this.storage.runs.setStatus(interrupted, 'interrupted');
    }
    this.stream.flush();
    this.storage.observations.flush();
    this.storage.close();
  }

  private launch(
    work: Promise<StopReason>,
    runId: string,
    config: CrawlConfig,
    presetId: number | null,
  ): void {
    this.running = work
      .then((reason) => this.scheduleAutoRestart(reason, config, presetId))
      .catch((error: unknown) => {
        this.options.logger.error({ err: error, runId }, 'tarama beklenmedik şekilde sonlandı');
        this.storage.runs.finish(runId, 'failed', 'fatal_error', null);
        this.broadcaster.broadcast({
          type: 'fatal',
          code: 'run_crashed',
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.activeRun = null;
        this.cooldownUntil = null;
      });
  }

  /**
   * Sürekli tarama: bütçe / kart sınırı / tohum bitimiyle sona eren turdan
   * sonra sıradaki pazarla yeni tur. "Durdur" (`manual`) ve ölümcül hata
   * döngüyü keser; YouTube molası (cooldown) motorun içinde zaten bekleniyor.
   */
  private scheduleAutoRestart(
    reason: StopReason,
    config: CrawlConfig,
    presetId: number | null,
  ): void {
    if (!config.autoRestart || this.closing || !AUTO_RESTART_REASONS.has(reason)) return;
    const next = nextAutoRestartConfig(config);
    const delay = this.options.autoRestartDelayMs ?? 60_000;
    this.restartAt = systemClock.now() + delay;
    this.options.logger.info(
      { reason, next: next.crawlLanguages, delay },
      'sürekli tarama: sonraki tur planlandı',
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartAt = null;
      if (this.closing || this.isBusy) return;
      try {
        this.startRun(next, presetId);
      } catch (error) {
        this.options.logger.error({ err: error }, 'sürekli tarama: tur başlatılamadı');
      }
    }, delay);
  }

  /** Kayıtlı nabız durumunu geri yükler; yoksa başlangıç limitleri geçerli. */
  private async restorePulse(): Promise<void> {
    try {
      const raw = await this.storage.kv.get(KV_PULSE_STATE);
      if (raw === null) {
        this.applyPulse(this.pulse.snapshot.limits);
        return;
      }
      const saved = JSON.parse(raw) as Partial<PulseState>;
      const restored = new PulseController(() => systemClock.now(), saved);
      this.pulse = restored;
      this.applyPulse(restored.snapshot.limits);
      this.options.logger.info({ pulse: restored.snapshot }, 'nabız: kayıtlı limitler yüklendi');
    } catch (error) {
      this.options.logger.error({ err: error }, 'nabız: kayıtlı durum okunamadı');
    }
  }

  private applyPulse(limits: PulseLimits): void {
    this.adapter.governor.setLimits(limits);
    void this.storage.kv.set(KV_PULSE_STATE, JSON.stringify(this.pulse.snapshot));
  }

  private pulseTick(): void {
    const changed = this.pulse.tick(this.adapter.governor.stats);
    if (changed !== null) {
      this.applyPulse(changed);
      this.options.logger.info({ pulse: this.pulse.snapshot }, 'nabız: hızlanıldı');
    }
  }

  /** Mola dışı uyarılar: istatistik sayaçlarındaki artış. */
  private pulseWarnings(stats: FunnelStats): void {
    const now = {
      http429: stats.http429 ?? 0,
      emptyFeeds: stats.emptyFeeds ?? 0,
      loginRequired: stats.loginRequired ?? 0,
    };
    const prev = this.lastWarnCounts;
    this.lastWarnCounts = now;
    const what: string[] = [];
    if (now.http429 > prev.http429) what.push('429');
    if (now.emptyFeeds > prev.emptyFeeds) what.push('boş feed');
    if (now.loginRequired > prev.loginRequired) what.push('giriş istendi');
    if (what.length === 0) return;
    this.applyPulse(this.pulse.onWarning(what.join(', ')));
    this.options.logger.info({ pulse: this.pulse.snapshot }, 'nabız: uyarı, yavaşlandı');
  }

  private trackLiveState(event: DomainEvent): void {
    if (event.type === 'cooldown_started') {
      this.applyPulse(this.pulse.onCooldown(event.cause));
      this.options.logger.info({ pulse: this.pulse.snapshot }, 'nabız: mola, sert yavaşlandı');
      this.cooldownUntil = event.until;
    } else if (event.type === 'state_changed') {
      this.cooldownUntil = this.phase === 'cooldown' ? this.cooldownUntil : null;
    } else if (event.type === 'stats_tick') {
      this.lastStats = event.stats;
      this.pulseWarnings(event.stats);
    } else if (event.type === 'run_finished') {
      this.lastStats = event.stats;
    } else if (event.type === 'run_started') {
      this.lastStats = null;
      this.lastWarnCounts = { http429: 0, emptyFeeds: 0, loginRequired: 0 };
    }
  }
}

export class RunConflictError extends Error {
  constructor() {
    super('Zaten çalışan bir tarama var');
    this.name = 'RunConflictError';
  }
}
