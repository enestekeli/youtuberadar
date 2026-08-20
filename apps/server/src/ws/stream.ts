import type { Clock } from '@hype/core';
import type {
  DomainEvent,
  EventEnvelope,
  LogLevel,
  LogLine,
  Match,
  PoolItem,
  PoolScore,
  RawVideoCard,
} from '@hype/shared';
import type { Broadcaster } from './broadcaster.js';

/** Log satırları toplu gönderilir; 20 olay/saniyede bile React ~10 kez commit eder. */
export const LOG_BATCH_SIZE = 50;
export const LOG_BATCH_MS = 100;
/** İstatistikler saniyede birden sık gönderilmez. */
export const STATS_THROTTLE_MS = 1000;

interface StreamState {
  runId: string | null;
  /** Arayüzde "skorlanıyor…" kartı gösterilen videolar. */
  pendingCards: Set<string>;
}

/**
 * Motor olaylarını arayüzün anladığı akışa çevirir.
 *
 * En önemli davranışı progressive hydration: bir video ücretsiz kapıları
 * geçtiği anda karta dönüşüp grid'e düşer ("skorlanıyor…"), kanal çözülünce
 * rozeti canlanır ya da kart sessizce geri çekilir. Aksi hâlde arayüz, kanal
 * isteği beklerken saniyelerce donmuş görünürdü.
 */
export class DashboardStream {
  private logBuffer: LogLine[] = [];
  private logTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatsAt = 0;
  private lineSeq = 0;
  private state: StreamState = { runId: null, pendingCards: new Set() };

  constructor(
    private readonly broadcaster: Broadcaster,
    private readonly clock: Clock,
    /** Satırlar diske de yazılır: geçmiş bir taramanın terminali yeniden açılabilsin. */
    private readonly persist?: (runId: string, lines: readonly LogLine[]) => void,
  ) {}

  /** Geç bağlanan istemciye gönderilen son log kuyruğu — güncel taramaya ait. */
  private readonly tail: LogLine[] = [];

  get logTail(): LogLine[] {
    return [...this.tail];
  }

  handle(envelope: EventEnvelope): void {
    const { event, runId } = envelope;
    this.translate(event, runId);
    const line = toLogLine(event, this.clock.now(), `l${++this.lineSeq}`);
    if (line !== null) this.pushLog(line);
  }

  flush(): void {
    if (this.logTimer !== null) {
      clearTimeout(this.logTimer);
      this.logTimer = null;
    }
    if (this.logBuffer.length === 0) return;
    const lines = this.logBuffer;
    this.logBuffer = [];
    this.broadcaster.broadcast({ type: 'log', runId: this.state.runId, lines });
    if (this.state.runId !== null) this.persist?.(this.state.runId, lines);
  }

  private translate(event: DomainEvent, runId: string | null): void {
    switch (event.type) {
      case 'run_started':
        this.state = { runId: event.runId, pendingCards: new Set() };
        // Kuyruk taramaya özel: sayfa yenilendiğinde önceki taramanın satırları
        // geri gelip "0 tarandı ama 400 satır log" gibi çelişki üretmemeli.
        this.tail.length = 0;
        this.broadcaster.broadcast({
          type: 'run:status',
          runId: event.runId,
          state: 'seeding',
        });
        break;

      case 'state_changed':
        this.broadcaster.broadcast({
          type: 'run:status',
          runId,
          state: event.to,
          ...(event.cooldownUntil === undefined ? {} : { cooldownUntil: event.cooldownUntil }),
        });
        break;

      case 'cooldown_started':
        this.broadcaster.broadcast({
          type: 'run:status',
          runId,
          state: 'cooldown',
          detail: event.cause,
          cooldownUntil: event.until,
        });
        break;

      case 'video_scanned':
        if (runId === null) break;
        // Ücretsiz kapıları geçti: kartı hemen göster, skoru sonra doldur.
        this.state.pendingCards.add(event.card.videoId);
        this.broadcaster.broadcast({
          type: 'pool:add',
          runId,
          item: toPendingItem(event.card, runId, event.depth),
        });
        break;

      case 'video_matched':
        if (runId === null) break;
        this.state.pendingCards.delete(event.match.videoId);
        this.broadcaster.broadcast({
          type: 'pool:update',
          runId,
          videoId: event.match.videoId,
          patch: {
            score: toPoolScore(event.match),
            channelName: event.match.channelName,
            subsText: event.match.subsText,
            subsApprox: event.match.subsApprox,
            channelIsHot: event.match.channelIsHot,
            caughtAt: event.match.caughtAt,
            receipts:
              event.match.baselineMedian !== null && event.match.baselineN !== null
                ? {
                    baselineN: event.match.baselineN,
                    baselineMedian: event.match.baselineMedian,
                    baselineSamples: [],
                  }
                : null,
          },
        });
        break;

      case 'video_skipped':
        if (runId === null) break;
        // Bekleyen kart varsa geri çek — kullanıcı boşuna umutlanmasın.
        if (this.state.pendingCards.delete(event.videoId)) {
          this.broadcaster.broadcast({
            type: 'pool:remove',
            runId,
            videoId: event.videoId,
            reason: 'failed_gate',
          });
        }
        break;

      case 'stats_tick': {
        const now = this.clock.now();
        if (runId === null || now - this.lastStatsAt < STATS_THROTTLE_MS) break;
        this.lastStatsAt = now;
        this.broadcaster.broadcast({ type: 'stats', runId, stats: event.stats });
        break;
      }

      case 'run_finished':
        this.flush();
        this.broadcaster.broadcast({
          type: 'run:status',
          runId: event.runId,
          state: 'stopped',
          detail: event.reason,
        });
        this.broadcaster.broadcast({ type: 'stats', runId: event.runId, stats: event.stats });
        this.state = { runId: null, pendingCards: new Set() };
        break;

      case 'engine_error':
        if (event.fatal) {
          this.broadcaster.broadcast({ type: 'fatal', code: 'engine', message: event.message });
        }
        break;

      default:
        break;
    }
  }

  private pushLog(line: LogLine): void {
    this.logBuffer.push(line);
    this.tail.push(line);
    if (this.tail.length > 500) this.tail.shift();

    if (this.logBuffer.length >= LOG_BATCH_SIZE) {
      this.flush();
      return;
    }
    this.logTimer ??= setTimeout(() => this.flush(), LOG_BATCH_MS);
  }
}

/**
 * Yakalanan kaydı arayüzün beklediği skora çevirir.
 *
 * `scoreType` ÖNCE okunuyor: kanal çarpanı `vsr` alanını paylaşıyor (DB'deki
 * CHECK kısıtı yüzünden), ayrımı yapan tek şey bu alan.
 */
function toPoolScore(match: Match): PoolScore {
  const common = {
    lowConfidence: match.lowConfidence,
    lowConfidenceReasons: match.lowConfidenceReasons,
  };

  if (match.scoreType === 'channel' && match.vsr !== null) {
    return {
      type: 'channel',
      value: match.vsr,
      hitRate: match.channelHitRate ?? 0,
      channelAgeDays: match.channelAgeDays,
      uploads: match.baselineN ?? 0,
      ...common,
    };
  }
  if (match.scoreType === 'hype' && match.hype !== null) {
    return { type: 'hype', value: match.hype, z: match.z, ...common };
  }
  if (match.vsr !== null) return { type: 'vsr', value: match.vsr, ...common };
  return { type: 'pending' };
}

function toPendingItem(card: RawVideoCard, runId: string, depth: number): PoolItem {
  const views = card.viewsApprox ?? 0;
  const ageDays = card.publishedAgeDays ?? 0;
  return {
    videoId: card.videoId,
    runId,
    title: card.title,
    thumbnailUrl: card.thumbnailUrl,
    durationSec: card.durationSec,
    channelId: card.channelId,
    channelName: card.channelName,
    subsText: null,
    // Kanal henüz çözülmedi; abone sayısı skorla birlikte gelecek.
    subsApprox: null,
    views,
    ageDays,
    vpd: views / Math.max(ageDays, 0.5),
    score: { type: 'pending' },
    receipts: null,
    channelIsHot: false,
    suspectedBoughtTraffic: false,
    discarded: false,
    depth,
    caughtAt: null,
  };
}

/** Terminale basılacak satır. Sebep kodları kısaltılmadan gösterilir. */
function toLogLine(event: DomainEvent, ts: number, id: string): LogLine | null {
  const base = { id, ts };

  switch (event.type) {
    case 'run_started':
      return { ...base, level: 'info', msg: `Tarama başladı (${event.runId})` };
    case 'seed_acquired':
      return {
        ...base,
        level: 'seed',
        msg: `${event.manual ? 'Manuel tohum' : 'Tohum alındı'}: ${event.title || event.videoId}`,
        videoId: event.videoId,
      };
    case 'depth_changed':
      return { ...base, level: 'visit', msg: `Derinlik ${event.depth}/${event.maxDepth}` };
    case 'node_expanded':
      return {
        ...base,
        level: 'visit',
        msg: `Genişletildi: ${event.videoId} → ${event.cardCount} komşu (derinlik ${event.depth})`,
        videoId: event.videoId,
      };
    case 'video_skipped':
      return {
        ...base,
        level: 'skip',
        msg: `Atlandı: ${truncate(event.title ?? event.videoId)} — ${event.reason}`,
        videoId: event.videoId,
        data: { stage: event.stage, reason: event.reason },
      };
    case 'video_matched':
      return {
        ...base,
        level: 'match',
        msg: `YAKALANDI: ${truncate(event.match.title)} — ${formatScore(event.match)}`,
        videoId: event.match.videoId,
        data: { hype: event.match.hype, vsr: event.match.vsr },
      };
    case 'channel_resolved':
      return {
        ...base,
        level: 'channel',
        msg: `Kanal ${event.cacheHit ? 'önbellekten' : 'çekildi'}: ${event.channelId} (${event.subsApprox ?? 'abone gizli'})`,
        channelId: event.channelId,
      };
    case 'cooldown_started':
      return {
        ...base,
        level: 'rate',
        msg: `Mola: ${event.cause} — ${Math.round((event.until - ts) / 60_000)} dk (seviye ${event.level})`,
      };
    case 'parser_warning':
      return {
        ...base,
        level: 'warn',
        msg: `Ayrıştırıcı uyarısı: ${event.errorType} (${event.className}) — YouTube arayüzü değişmiş olabilir`,
      };
    case 'engine_error':
      return { ...base, level: event.fatal ? 'error' : 'warn', msg: event.message };
    case 'run_finished':
      return {
        ...base,
        level: 'info',
        msg: `Tarama bitti (${event.reason}): ${event.stats.scanned} tarandı, ${event.stats.matched} yakalandı`,
      };
    default:
      return null;
  }
}

function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Terminal satırı dar; 1_250_000 yerine "1.2M". */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}B`;
  return String(Math.round(n));
}

function formatScore(match: Match): string {
  if (match.scoreType === 'channel' && match.vsr !== null) {
    /*
     * Satır, kanalı havuza sokan İKİ sayıyı gösteriyor: yaş ve medyan izlenme.
     * Çarpan da duruyor ama tek başına yanıltıcı olurdu — kapı o değil.
     */
    const age =
      match.channelAgeDays === null
        ? 'yaş bilinmiyor'
        : `${Math.round(match.channelAgeDays)} günlük`;
    const median = compact(match.baselineMedian ?? 0);
    return `KANAL ${age} · medyan ${median} (${match.baselineN ?? 0} video) · ${match.vsr.toFixed(1)}x`;
  }
  if (match.hype !== null) return `${match.hype.toFixed(1)}x`;
  if (match.vsr !== null) return `${match.vsr.toFixed(1)}x VSR`;
  return 'skor yok';
}

export type { LogLevel };
