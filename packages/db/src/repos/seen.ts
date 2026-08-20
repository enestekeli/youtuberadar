import type { SeenRepo } from '@hype/core';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { videos } from '../schema.js';

/**
 * "Görüldü" = havuza girmiş ya da çöpe atılmış.
 *
 * Ayrı bir tablo yok: `videos` tablosunun kendisi bu bilginin kaynağı. Elenen
 * videolar buraya yazılmaz — kullanıcı eşiği ya da abone aralığını
 * değiştirdiğinde daha önce elenmiş videoların yeniden değerlendirilebilmesi
 * gerekir.
 *
 * Sıcak yol olduğu için (her taranan kart için bir sorgu) küçük bir bellek
 * önbelleği var; `videos` yalnızca bu süreçten yazıldığı için tutarlı kalır.
 */
export class SqliteSeenRepo implements SeenRepo {
  private readonly cache = new Set<string>();
  private readonly misses = new Set<string>();

  constructor(private readonly db: Db) {}

  async has(videoId: string): Promise<boolean> {
    if (this.cache.has(videoId)) return true;
    if (this.misses.has(videoId)) return false;

    const row = this.db
      .select({ videoId: videos.videoId })
      .from(videos)
      .where(eq(videos.videoId, videoId))
      .get();

    if (row === undefined) {
      // Negatif önbellek sınırsız büyümesin: oturum başına birkaç bin kayıt.
      if (this.misses.size > 20_000) this.misses.clear();
      this.misses.add(videoId);
      return false;
    }
    this.cache.add(videoId);
    return true;
  }

  async add(videoId: string): Promise<void> {
    this.cache.add(videoId);
    this.misses.delete(videoId);
  }
}
