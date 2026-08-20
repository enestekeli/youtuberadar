import { type DbHandle, openDatabase } from './client.js';
import { KV_MAINTENANCE_LAST_RUN, runMaintenance, shouldRunMaintenance } from './maintenance.js';
import { SqliteChannelCacheRepo } from './repos/channels.js';
import { SqliteExportRepo } from './repos/exports.js';
import { SqliteKvRepo } from './repos/kv.js';
import { SqliteLogRepo } from './repos/logs.js';
import { SqliteObservationRepo } from './repos/observations.js';
import { SqlitePresetRepo } from './repos/presets.js';
import { SqliteRunRepo } from './repos/runs.js';
import { SqliteSeenRepo } from './repos/seen.js';
import { SqliteVideoRepo } from './repos/videos.js';

export * from './client.js';
export * from './maintenance.js';
export * from './repos/channels.js';
export * from './repos/exports.js';
export * from './repos/kv.js';
export * from './repos/logs.js';
export * from './repos/observations.js';
export * from './repos/presets.js';
export * from './repos/runs.js';
export * from './repos/seen.js';
export * from './repos/videos.js';
export * from './schema.js';
export * from './subscriber.js';

export interface StorageOptions {
  path: string;
  appVersion: string;
  now?: () => number;
}

export interface Storage {
  handle: DbHandle;
  kv: SqliteKvRepo;
  channels: SqliteChannelCacheRepo;
  seen: SqliteSeenRepo;
  videos: SqliteVideoRepo;
  runs: SqliteRunRepo;
  observations: SqliteObservationRepo;
  presets: SqlitePresetRepo;
  exports: SqliteExportRepo;
  logs: SqliteLogRepo;
  close(): void;
}

/**
 * Kalıcılık katmanını tek çağrıda kurar.
 *
 * Açılış sırası önemli: migration → yerleşik presetler → çökme kurtarma →
 * bakım. "Çalışıyor" görünen oturumları `interrupted` işaretlemek migration'dan
 * hemen sonra gelmeli ki arayüz hayalet bir tarama göstermesin.
 */
export function createStorage(options: StorageOptions): Storage {
  const now = options.now ?? (() => Date.now());
  const handle = openDatabase(options.path);
  const { db } = handle;

  const kv = new SqliteKvRepo(db, now);
  const runs = new SqliteRunRepo(db, now, options.appVersion);
  const presets = new SqlitePresetRepo(db, now);

  presets.seedBuiltins();
  runs.markInterrupted();

  const storage: Storage = {
    handle,
    kv,
    runs,
    presets,
    channels: new SqliteChannelCacheRepo(db, now),
    seen: new SqliteSeenRepo(db),
    videos: new SqliteVideoRepo(db, now),
    observations: new SqliteObservationRepo(db, now),
    exports: new SqliteExportRepo(db, now),
    logs: new SqliteLogRepo(db),
    close: () => handle.close(),
  };

  void maybeMaintain(storage, now());
  return storage;
}

async function maybeMaintain(storage: Storage, now: number): Promise<void> {
  const lastRun = await storage.kv.get(KV_MAINTENANCE_LAST_RUN);
  if (!shouldRunMaintenance(lastRun, now)) return;
  runMaintenance(storage.handle.db, now);
  await storage.kv.set(KV_MAINTENANCE_LAST_RUN, String(now));
}
