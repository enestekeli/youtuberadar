import { and, lt, ne, notInArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { channels, observations, videos } from './schema.js';

const DAY = 86_400_000;

/**
 * VERİ SİLİNMEZ.
 *
 * Bu araçta saklama maliyeti pratikte sıfır: bir gözlem satırı ~200 bayt, yılda
 * yüz binlerce satır bile birkaç yüz megabayt eder. Buna karşılık silinen veri
 * geri gelmez ve asıl değeri sonradan ortaya çıkar:
 *
 *   "Eşiği 3'e düşürseydim geçen ay hangi videolar gelirdi?"
 *   "Bu kanalı üç ay önce neden elemişim?"
 *   "Hangi tohum terimi daha çok hit üretiyor?"
 *
 * Bu soruların hepsi ancak elenen videoların metrikleriyle birlikte saklanmasıyla
 * cevaplanabilir. Bu yüzden otomatik budama KAPALI; aşağıdaki fonksiyon yalnızca
 * kullanıcı açıkça isterse (ileride bir "arşivi temizle" komutuyla) çağrılır.
 */
export const AUTO_PRUNE_ENABLED = false;

/** Bakım günde bir çalışır; ama varsayılan olarak yalnızca indeks optimizasyonu yapar. */
export const MAINTENANCE_INTERVAL_MS = DAY;
export const KV_MAINTENANCE_LAST_RUN = 'maintenance_last_run';

export interface PruneOptions {
  /** Bu yaştan eski elemeler silinir. null = silme. */
  observationRetentionMs?: number | null;
  /** Bu yaştan eski, hiçbir videoya bağlı olmayan kanal önbelleği silinir. */
  channelRetentionMs?: number | null;
}

export interface MaintenanceReport {
  observationsDeleted: number;
  channelsDeleted: number;
  optimized: boolean;
}

/**
 * Rutin bakım. Varsayılan davranış: hiçbir şey silmez, yalnızca SQLite'ın sorgu
 * planlayıcısını tazeler.
 */
export function runMaintenance(db: Db, _now: number): MaintenanceReport {
  db.run(sql`PRAGMA optimize`);
  return { observationsDeleted: 0, channelsDeleted: 0, optimized: true };
}

/**
 * Açık istek üzerine arşiv budama.
 *
 * Yalnızca kullanıcı veritabanını küçültmek istediğinde çağrılır. Yakalanan
 * videolar (`videos`) ve kara listeye alınmış kanallar HİÇBİR koşulda silinmez:
 * ilki kullanıcının kararını, ikincisi bedava eleme kabiliyetini taşır.
 */
export function pruneArchive(db: Db, now: number, options: PruneOptions = {}): MaintenanceReport {
  const observationRetentionMs = options.observationRetentionMs ?? null;
  const channelRetentionMs = options.channelRetentionMs ?? null;

  let observationsDeleted = 0;
  if (observationRetentionMs !== null) {
    observationsDeleted = db
      .delete(observations)
      .where(
        and(
          lt(observations.createdAt, now - observationRetentionMs),
          ne(observations.verdict, 'caught'),
        ),
      )
      .run().changes;
  }

  let channelsDeleted = 0;
  if (channelRetentionMs !== null) {
    const referenced = db.select({ channelId: videos.channelId }).from(videos);
    channelsDeleted = db
      .delete(channels)
      .where(
        and(
          lt(channels.updatedAt, now - channelRetentionMs),
          ne(channels.verdict, 'blocklisted'),
          notInArray(channels.channelId, referenced),
        ),
      )
      .run().changes;
  }

  db.run(sql`PRAGMA optimize`);
  return { observationsDeleted, channelsDeleted, optimized: true };
}

export function shouldRunMaintenance(lastRun: string | null, now: number): boolean {
  if (lastRun === null) return true;
  const timestamp = Number.parseInt(lastRun, 10);
  if (!Number.isFinite(timestamp)) return true;
  return now - timestamp >= MAINTENANCE_INTERVAL_MS;
}
