import type { EngineSnapshot } from '@hype/core';
import {
  type CrawlConfig,
  CrawlConfigSchema,
  type FunnelStats,
  FunnelStatsSchema,
  type RunDetail,
} from '@hype/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { runs } from '../schema.js';

/** Motorun fazlarına ek olarak, çökme sonrası atanan durum. */
export type RunStatus =
  | 'running'
  | 'paused'
  | 'cooldown'
  | 'interrupted'
  | 'completed'
  | 'aborted'
  | 'failed';

const LIVE_STATUSES: RunStatus[] = ['running', 'paused', 'cooldown'];

export class SqliteRunRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly appVersion: string,
  ) {}

  create(runId: string, config: CrawlConfig, presetId: number | null): void {
    this.db
      .insert(runs)
      .values({
        runId,
        status: 'running',
        configJson: JSON.stringify(config),
        presetId,
        appVersion: this.appVersion,
        startedAt: this.now(),
      })
      .run();
  }

  setStatus(runId: string, status: RunStatus): void {
    this.db.update(runs).set({ status }).where(eq(runs.runId, runId)).run();
  }

  updateStats(runId: string, stats: FunnelStats): void {
    this.db
      .update(runs)
      .set({ statsJson: JSON.stringify(stats) })
      .where(eq(runs.runId, runId))
      .run();
  }

  saveSnapshot(snapshot: EngineSnapshot): void {
    this.db
      .update(runs)
      .set({ frontierSnapshotJson: JSON.stringify(snapshot) })
      .where(eq(runs.runId, snapshot.runId))
      .run();
  }

  loadSnapshot(runId: string): EngineSnapshot | null {
    const row = this.db.select().from(runs).where(eq(runs.runId, runId)).get();
    if (row?.frontierSnapshotJson == null) return null;
    try {
      return JSON.parse(row.frontierSnapshotJson) as EngineSnapshot;
    } catch {
      return null;
    }
  }

  finish(runId: string, status: RunStatus, stopReason: string, stats: FunnelStats | null): void {
    this.db
      .update(runs)
      .set({
        status,
        stopReason,
        endedAt: this.now(),
        ...(stats === null ? {} : { statsJson: JSON.stringify(stats) }),
      })
      .where(eq(runs.runId, runId))
      .run();
  }

  /**
   * Açılışta çağrılır: süreç çökmüşse "çalışıyor" görünen oturumlar kalır.
   * Onları `interrupted` işaretlemek, arayüzün "Devam et" sunabilmesini sağlar
   * ve sonsuza dek çalışıyor görünen hayalet oturumları temizler.
   */
  markInterrupted(): number {
    const result = this.db
      .update(runs)
      .set({ status: 'interrupted' })
      .where(inArray(runs.status, LIVE_STATUSES))
      .run();
    return result.changes;
  }

  get(runId: string): RunDetail | null {
    const row = this.db.select().from(runs).where(eq(runs.runId, runId)).get();
    return row === undefined ? null : toDetail(row);
  }

  list(limit = 50): RunDetail[] {
    return this.db
      .select()
      .from(runs)
      .orderBy(desc(runs.startedAt))
      .limit(limit)
      .all()
      .map(toDetail);
  }

  findResumable(): RunDetail | null {
    const row = this.db
      .select()
      .from(runs)
      .where(eq(runs.status, 'interrupted'))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();
    return row === undefined ? null : toDetail(row);
  }
}

function toDetail(row: typeof runs.$inferSelect): RunDetail {
  return {
    runId: row.runId,
    // Kalıcı durumlar motor fazlarıyla birebir örtüşmez; arayüz için eşlenir.
    status: mapStatus(row.status),
    config: CrawlConfigSchema.parse(JSON.parse(row.configJson)),
    stats: parseStats(row.statsJson),
    stopReason: row.stopReason,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

function mapStatus(status: string): RunDetail['status'] {
  switch (status) {
    case 'running':
      return 'crawling';
    case 'paused':
      return 'paused';
    case 'cooldown':
      return 'cooldown';
    default:
      return 'stopped';
  }
}

function parseStats(json: string | null): FunnelStats | null {
  if (json === null) return null;
  const parsed = FunnelStatsSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}
