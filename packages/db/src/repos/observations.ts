import type { GateName, SkipReason } from '@hype/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { observations } from '../schema.js';

export interface ObservationDetails {
  title?: string | null;
  views?: number | null;
  ageDays?: number | null;
  vpd?: number | null;
  [key: string]: unknown;
}

export interface ObservationRow {
  videoId: string;
  channelId: string | null;
  depth: number;
  stage: string;
  verdict: string;
  details: ObservationDetails | null;
  createdAt: number;
}

export interface ObservationInput {
  runId: string;
  videoId: string;
  channelId?: string | null;
  depth: number;
  stage: GateName | 'caught';
  verdict: SkipReason | 'caught';
  details?: Record<string, unknown>;
}

/**
 * Huni günlüğü yazıcısı.
 *
 * Yazma hacmi yüksek (taranan her video için bir satır), bu yüzden tamponlanıp
 * tek transaction'da yazılıyor. `better-sqlite3` senkron olduğu için tek bir
 * transaction yüzlerce satırı bir disk senkronizasyonuyla halleder — satır
 * satır yazmak taramayı gözle görülür yavaşlatırdı.
 */
export class SqliteObservationRepo {
  private buffer: ObservationInput[] = [];

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly flushThreshold = 50,
  ) {}

  record(input: ObservationInput): void {
    this.buffer.push(input);
    if (this.buffer.length >= this.flushThreshold) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const createdAt = this.now();

    const rows = batch.map((o) => ({
      runId: o.runId,
      videoId: o.videoId,
      channelId: o.channelId ?? null,
      depth: o.depth,
      stage: o.stage,
      verdict: o.verdict,
      detailsJson: o.details === undefined ? null : JSON.stringify(o.details),
      createdAt,
    }));

    this.db.transaction((tx) => {
      for (const row of rows) {
        // Aynı taramada aynı video iki kez gözlemlenebilir (farklı ebeveynden);
        // ilk gözlem korunur.
        tx.insert(observations).values(row).onConflictDoNothing().run();
      }
    });
  }

  /**
   * Bir taramanın tüm gözlemleri — geçmişe dönük analiz için.
   *
   * Metrikler saklandığı için "eşiği 3'e düşürseydim hangileri gelirdi?"
   * sorusu eski taramalar üzerinde de cevaplanabilir.
   */
  listForRun(runId: string, limit = 5000): ObservationRow[] {
    return this.db
      .select()
      .from(observations)
      .where(eq(observations.runId, runId))
      .orderBy(observations.id)
      .limit(limit)
      .all()
      .map((row) => ({
        videoId: row.videoId,
        channelId: row.channelId,
        depth: row.depth,
        stage: row.stage,
        verdict: row.verdict,
        details:
          row.detailsJson === null ? null : (JSON.parse(row.detailsJson) as ObservationDetails),
        createdAt: row.createdAt,
      }));
  }

  /** Eleme sebeplerinin dağılımı — "tarama neden boş döndü?" sorusunun cevabı. */
  verdictBreakdown(runId: string): Record<string, number> {
    const rows = this.db
      .select({ verdict: observations.verdict, count: sql<number>`count(*)` })
      .from(observations)
      .where(eq(observations.runId, runId))
      .groupBy(observations.verdict)
      .all();

    const result: Record<string, number> = {};
    for (const row of rows) result[row.verdict] = row.count;
    return result;
  }
}
