import type { EnginePhase, FunnelStats, PoolItem, ServerEvent } from '@hype/shared';
import { create } from 'zustand';
import type { ConnectionState } from '../lib/ws-client.js';
import { logBuffer } from './log-buffer.js';

interface RealtimeState {
  connection: ConnectionState;
  retryInMs: number;
  protocolMismatch: number | null;
  phase: EnginePhase;
  activeRunId: string | null;
  cooldownUntil: number | null;
  statusDetail: string | null;
  stats: FunnelStats | null;
  /**
   * videoId → kart.
   *
   * Bu Map YERİNDE değiştiriliyor, her olayda kopyalanmıyor. Sebebi ölçüm:
   * 200 videoluk bir taramada ~400 havuz olayı oluyor (her aday önce
   * "skorlanıyor" kartı olarak ekleniyor, çoğu sonra geri çekiliyor) ve her
   * birinde tüm Map'i kopyalamak boşa iş. Bileşenler `pool` referansına değil
   * `poolVersion` sayacına abone olur.
   */
  pool: Map<string, PoolItem>;
  poolVersion: number;
  fatal: string | null;

  setConnection: (state: ConnectionState, retryInMs?: number) => void;
  setProtocolMismatch: (version: number) => void;
  apply: (event: ServerEvent) => void;
  discardLocally: (videoId: string) => void;
  restoreLocally: (item: PoolItem) => void;
  /** Geçmiş taramaların sonuçlarını görünüme yükler (veri hep duruyordu). */
  enterArchive: (items: readonly PoolItem[]) => void;
  /**
   * Arşivden çıkar. `items` verilirse havuz onunla kurulur; null ise arşive
   * girerken alınan yedek geri konur.
   */
  exitArchive: (items: readonly PoolItem[] | null) => void;
  archiveMode: boolean;
  /**
   * Arşive geçerken kenara alınan canlı havuz.
   *
   * Arşiv görünümü havuzun ÜSTÜNE yazıyor; yedek olmasa "geçmiş"e basmak
   * taramanın o ana kadarki sonuçlarını yok ederdi ve dönüş yolu kalmazdı.
   */
  livePool: Map<string, PoolItem> | null;
}

export const useRealtime = create<RealtimeState>((set) => ({
  connection: 'connecting',
  retryInMs: 0,
  protocolMismatch: null,
  phase: 'idle',
  activeRunId: null,
  cooldownUntil: null,
  statusDetail: null,
  stats: null,
  pool: new Map(),
  poolVersion: 0,
  fatal: null,
  archiveMode: false,
  livePool: null,

  setConnection: (connection, retryInMs = 0) => set({ connection, retryInMs }),
  setProtocolMismatch: (version) => set({ protocolMismatch: version }),

  /**
   * Tek yönlü olay uygulayıcı.
   *
   * Kart eklemeleri videoId anahtarlı ve idempotent: sunucu yeniden bağlanmada
   * olayları tekrar oynatsa bile kartlar çoğalmaz.
   */
  apply: (event) => {
    switch (event.type) {
      case 'snapshot': {
        logBuffer.replace(event.state.logTail);
        set((s) => {
          s.pool.clear();
          for (const item of event.state.pool) s.pool.set(item.videoId, item);
          return {
            phase: event.state.status,
            activeRunId: event.state.activeRun?.runId ?? null,
            cooldownUntil: event.state.cooldownUntil,
            stats: event.state.stats,
            poolVersion: s.poolVersion + 1,
          };
        });
        break;
      }

      case 'run:status':
        set((s) => {
          // Yeni bir tarama başladıysa havuz sıfırlanır: liste birikmez, her
          // tarama kendi sonuçlarını gösterir. (Kayıtlar veritabanında durur.)
          const isNewRun = event.runId !== null && event.runId !== s.activeRunId;
          if (isNewRun) {
            // Havuzla birlikte terminal de sıfırlanır: aksi hâlde yeni tarama
            // "0 video tarandı" derken terminalde önceki taramanın 400 satırı
            // duruyor ve iki gösterge birbirini yalanlıyordu.
            // (Satırlar veritabanında saklanıyor, kaybolmuyorlar.)
            s.pool.clear();
            logBuffer.clear();
          }
          return {
            phase: event.state,
            activeRunId: event.runId ?? s.activeRunId,
            cooldownUntil: event.cooldownUntil ?? null,
            statusDetail: event.detail ?? null,
            ...(isNewRun ? { poolVersion: s.poolVersion + 1 } : {}),
          };
        });
        break;

      case 'stats':
        set({ stats: event.stats });
        break;

      case 'log':
        logBuffer.append(event.lines);
        break;

      case 'pool:add':
        set((s) => {
          const previous = s.pool.get(event.item.videoId);
          // Skor zaten dolduysa, tekrar oynatılan bir "bekliyor" kartı onu ezmesin.
          s.pool.set(
            event.item.videoId,
            previous !== undefined && event.item.score.type === 'pending'
              ? { ...event.item, score: previous.score, receipts: previous.receipts }
              : event.item,
          );
          return { poolVersion: s.poolVersion + 1 };
        });
        break;

      case 'pool:update':
        set((s) => {
          const existing = s.pool.get(event.videoId);
          if (existing === undefined) return s;
          // Kartın kendisi YENİ nesne: React.memo yalnızca değişen kartı
          // yeniden çizsin diye referans değişmeli.
          s.pool.set(event.videoId, mergePatch(existing, event.patch));
          return { poolVersion: s.poolVersion + 1 };
        });
        break;

      case 'pool:remove':
        set((s) => {
          if (!s.pool.delete(event.videoId)) return s;
          return { poolVersion: s.poolVersion + 1 };
        });
        break;

      case 'fatal':
        set({ fatal: event.message });
        break;

      default:
        break;
    }
  },

  discardLocally: (videoId) =>
    set((s) => {
      s.pool.delete(videoId);
      return { poolVersion: s.poolVersion + 1 };
    }),

  restoreLocally: (item) =>
    set((s) => {
      s.pool.set(item.videoId, item);
      return { poolVersion: s.poolVersion + 1 };
    }),

  enterArchive: (items) =>
    set((s) => {
      // Zaten arşivdeysek yedeği EZME: ikinci kez girmek canlı havuzu kaybettirir.
      const livePool = s.archiveMode ? s.livePool : new Map(s.pool);
      s.pool.clear();
      for (const item of items) s.pool.set(item.videoId, item);
      return { poolVersion: s.poolVersion + 1, archiveMode: true, livePool };
    }),

  exitArchive: (items) =>
    set((s) => {
      /*
       * Tarama sürüyorsa çağıran taraf sunucudan tazesini getiriyor: arşive
       * bakarken yeni yakalamalar gelmiş olabilir ve yedek onları bilmez.
       * Tarama yoksa yedek zaten kesin doğru.
       */
      const source: Iterable<PoolItem> = items ?? s.livePool?.values() ?? [];
      s.pool.clear();
      for (const item of source) s.pool.set(item.videoId, item);
      return { poolVersion: s.poolVersion + 1, archiveMode: false, livePool: null };
    }),
}));

/**
 * Kısmi yamayı uygular. Düz spread kullanılamaz: yamada bulunmayan alanlar
 * `undefined` olarak gelir ve mevcut değerleri silerdi.
 */
function mergePatch(
  base: PoolItem,
  patch: { [K in keyof PoolItem]?: PoolItem[K] | undefined },
): PoolItem {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value;
  }
  return result as PoolItem;
}

/**
 * Havuzun görünecek hâli: çöpe atılanlar düşülmüş, en yeni yakalama başta.
 *
 * GÖRÜNÜM FİLTRESİ YOK — bilinçli. Elemeyi tarama zaten yapıyor ve bir
 * taramadan çıkan sonuç 3–5 kart; onları ikinci bir filtre katmanıyla
 * dilimlemek eleme değil, kaybetme riski üretiyordu. Nitekim öyle de oldu:
 * görünmeyen bir 5x eşiği yakalanan bütün kanalları gizledi. Kartların
 * kendisi zaten makbuzlarını taşıyor; karşılaştırmayı göz yapıyor.
 *
 * Zustand seçicisi OLARAK kullanılamaz: her çağrıda yeni bir dizi üretir ve
 * referans eşitliğine bakan store sonsuz render döngüsüne girer. Çağıran taraf
 * `poolVersion`'a abone olup sonucu `useMemo` ile türetir.
 */
export function visiblePool(pool: ReadonlyMap<string, PoolItem>): PoolItem[] {
  const items: PoolItem[] = [];
  for (const item of pool.values()) {
    if (item.discarded) continue;
    items.push(item);
  }
  /*
   * En yeni yakalama başta. Sıralama seçici de kaldırıldığı için tek bir
   * ölçüt kalmalıydı; "en son ne buldu" tarama izlerken doğal okuma, üstelik
   * kanal ve video kartlarının ortak bir ölçeği olmadığı için çarpana göre
   * sıralamak zaten elmayla armut kıyaslıyordu.
   */
  items.sort((a, b) => (b.caughtAt ?? 0) - (a.caughtAt ?? 0));
  return items;
}
