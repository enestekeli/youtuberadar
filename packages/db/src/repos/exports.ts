import { EXPORT_SCHEMA_VERSION, type ExportEnvelope } from '@hype/shared';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { videoExports } from '../schema.js';

export type ExportDestination = 'payload' | 'file' | 'webhook';

export interface ExportRecord {
  videoId: string;
  destination: ExportDestination;
  destinationDetail?: string | null;
  envelope: ExportEnvelope;
  ok: boolean;
  error?: string | null;
}

/**
 * Export kayıtları.
 *
 * Gönderilen TAM yük saklanıyor. Sebebi denetlenebilirlik: "bu videoyu AI'a
 * ne zaman, hangi skorlarla gönderdik?" sorusu, skorlar sonradan tazelenmiş
 * olsa bile cevaplanabilir kalmalı. Başarısız webhook denemeleri de yazılır.
 */
export class SqliteExportRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  record(input: ExportRecord): void {
    this.db
      .insert(videoExports)
      .values({
        videoId: input.videoId,
        exportedAt: this.now(),
        destination: input.destination,
        destinationDetail: input.destinationDetail ?? null,
        payloadVersion: EXPORT_SCHEMA_VERSION,
        payloadJson: JSON.stringify(input.envelope),
        ok: input.ok,
        error: input.error ?? null,
      })
      .run();
  }

  listForVideo(videoId: string, limit = 20): (typeof videoExports.$inferSelect)[] {
    return this.db
      .select()
      .from(videoExports)
      .where(eq(videoExports.videoId, videoId))
      .orderBy(desc(videoExports.exportedAt))
      .limit(limit)
      .all();
  }

  countForVideo(videoId: string): number {
    return this.db.select().from(videoExports).where(eq(videoExports.videoId, videoId)).all()
      .length;
  }
}
