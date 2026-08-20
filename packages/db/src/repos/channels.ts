import type { CachedChannel, ChannelCacheRepo, ChannelVerdict } from '@hype/core';
import { type ChannelSnapshot, RawVideoCardSchema } from '@hype/shared';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../client.js';
import { channels } from '../schema.js';

const UploadsSchema = z.array(RawVideoCardSchema);

/**
 * Kanal önbelleği.
 *
 * Yükleme listesi JSON olarak saklanıyor: ilişkisel olarak açmanın hiçbir
 * faydası yok (hiç sorgulanmıyor, atomik olarak yazılıp okunuyor) ama her
 * kanal için 30 satırlık bir tablo maliyeti olurdu.
 */
export class SqliteChannelCacheRepo implements ChannelCacheRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  async get(channelId: string): Promise<CachedChannel | null> {
    const row = this.db.select().from(channels).where(eq(channels.channelId, channelId)).get();
    if (row === undefined) return null;

    return {
      channelId: row.channelId,
      snapshot: this.toSnapshot(row),
      // Anlık görüntü bayatlasa bile abone sayısı hatırlanır: verdikt yeniden
      // değerlendirilebilsin diye.
      subsApprox: row.subsApprox,
      country: row.country,
      joinedAt: row.joinedAt,
      verdict: row.verdict as ChannelVerdict,
      verdictExpiresAt: row.verdictExpiresAt,
      snapshotFetchedAt: row.snapshotFetchedAt,
    };
  }

  async putSnapshot(
    snapshot: ChannelSnapshot,
    verdict: ChannelVerdict,
    verdictExpiresAt: number | null,
    fetchedAt: number,
  ): Promise<void> {
    const now = this.now();
    const values = {
      channelId: snapshot.channelId,
      name: snapshot.name,
      handle: snapshot.handle,
      subsApprox: snapshot.subsApprox,
      subsText: snapshot.subsText,
      subsHidden: snapshot.subsHidden,
      uploadsJson: JSON.stringify(snapshot.recentUploads),
      snapshotFetchedAt: fetchedAt,
      verdict,
      verdictExpiresAt,
      updatedAt: now,
    };

    this.db
      .insert(channels)
      .values({ ...values, fetchErrorCount: 0, createdAt: now })
      .onConflictDoUpdate({
        target: channels.channelId,
        set: { ...values, fetchErrorCount: 0 },
      })
      .run();
  }

  /**
   * "Hakkında" isteğinden öğrenilenler — ülke ve kuruluş tarihi tek yanıttan.
   *
   * `null` gelen alan bilinen doğruyu EZMEZ: `COALESCE(yeni, mevcut)` ile
   * yazıyoruz. YouTube'un şeması değiştiğinde ya da tek bir yanıt eksik
   * geldiğinde daha önce öğrendiğimizi kaybetmek, hiç öğrenmemekten kötüdür.
   */
  async putAbout(
    channelId: string,
    country: string | null,
    joinedAt: number | null,
  ): Promise<void> {
    const now = this.now();
    this.db
      .insert(channels)
      .values({ channelId, country, joinedAt, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: channels.channelId,
        set: {
          country: sql`COALESCE(${country}, ${channels.country})`,
          joinedAt: sql`COALESCE(${joinedAt}, ${channels.joinedAt})`,
          updatedAt: now,
        },
      })
      .run();
  }

  async putVerdict(
    channelId: string,
    verdict: ChannelVerdict,
    verdictExpiresAt: number | null,
  ): Promise<void> {
    const now = this.now();
    this.db
      .insert(channels)
      .values({ channelId, verdict, verdictExpiresAt, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: channels.channelId,
        set: { verdict, verdictExpiresAt, updatedAt: now },
      })
      .run();
  }

  private toSnapshot(row: typeof channels.$inferSelect): ChannelSnapshot | null {
    if (row.uploadsJson === null || row.snapshotFetchedAt === null) return null;

    // Bozuk/eskimiş JSON önbelleği çökertmemeli: anlık görüntü yokmuş gibi
    // davranıp yeniden çekilmesine izin veriyoruz.
    const parsed = UploadsSchema.safeParse(JSON.parse(row.uploadsJson));
    if (!parsed.success) return null;

    return {
      channelId: row.channelId,
      name: row.name,
      handle: row.handle,
      subsApprox: row.subsApprox,
      subsText: row.subsText,
      subsHidden: row.subsHidden,
      country: row.country,
      // `joinedAt` BURAYA girmiyor: kuruluş tarihi ayrı bir istekten geliyor,
      // anlık görüntünün parçası değil. `CachedChannel` üzerinden taşınıyor.
      recentUploads: parsed.data,
      fetchedAt: row.snapshotFetchedAt,
    };
  }
}
