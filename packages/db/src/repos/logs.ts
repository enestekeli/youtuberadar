import type { LogLine } from '@hype/shared';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { runLogs } from '../schema.js';

/**
 * Terminal satırlarını kalıcılaştırır.
 *
 * Toplu yazım: satırlar zaten paket hâlinde geliyor, her birini ayrı
 * transaction'da yazmak taramadan çok disk işi yapmak olurdu.
 */
export class SqliteLogRepo {
  constructor(private readonly db: Db) {}

  append(runId: string, lines: readonly LogLine[]): void {
    if (lines.length === 0) return;
    const rows = lines.map((line) => ({
      runId,
      ts: line.ts,
      level: line.level,
      msg: line.msg,
      videoId: line.videoId ?? null,
      channelId: line.channelId ?? null,
    }));
    this.db.transaction((tx) => {
      tx.insert(runLogs).values(rows).run();
    });
  }

  /** Geçmiş bir taramanın terminalini yeniden açmak için. */
  listForRun(runId: string, limit = 20_000): LogLine[] {
    return this.db
      .select()
      .from(runLogs)
      .where(eq(runLogs.runId, runId))
      .orderBy(asc(runLogs.id))
      .limit(limit)
      .all()
      .map((row) => ({
        id: `db${row.id}`,
        ts: row.ts,
        level: row.level as LogLine['level'],
        msg: row.msg,
        ...(row.videoId === null ? {} : { videoId: row.videoId }),
        ...(row.channelId === null ? {} : { channelId: row.channelId }),
      }));
  }

  countForRun(runId: string): number {
    return this.db.select().from(runLogs).where(eq(runLogs.runId, runId)).all().length;
  }
}
