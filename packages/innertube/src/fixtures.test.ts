import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelSnapshotSchema, RawVideoCardSchema } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Golden fixture regresyon testleri.
 *
 * `pnpm --filter @hype/innertube capture` canlı YouTube'dan yakalayıp buraya
 * yazar; çıktı depoya işlenir. Bu testler fixture'ların hem şemaya uyduğunu
 * hem de ALAN KAPSAMININ düşmediğini doğrular.
 *
 * Asıl değeri şu: YouTube şemayı değiştirdiğinde, yeniden yakalama + test
 * koşusu "neyin bozulduğunu" saatler süren tahmin yerine bir dosya farkı ve
 * kırmızı bir test olarak gösterir.
 */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function load<T>(name: string, schema: z.ZodType<T>): T | null {
  const path = join(FIXTURE_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Kartların belirtilen alanı kaç oranda dolu? */
function coverage(cards: readonly Record<string, unknown>[], field: string): number {
  if (cards.length === 0) return 0;
  return cards.filter((c) => c[field] !== null && c[field] !== undefined).length / cards.length;
}

const WatchNextSchema = z.object({
  cards: z.array(RawVideoCardSchema),
  continuation: z.string().nullable(),
});

describe('yakalanmış öneri rafı', () => {
  const page = load('watch-next', WatchNextSchema);

  it.runIf(page !== null)('şemaya uyar ve boş değildir', () => {
    expect(page?.cards.length ?? 0).toBeGreaterThan(5);
  });

  it.runIf(page !== null)('skorlama için gereken alanlar okunabiliyor', () => {
    const cards = (page?.cards ?? []) as unknown as Record<string, unknown>[];
    // Bu üçü olmadan hiçbir video skorlanamaz; kapsama düşerse ayrıştırıcı bozulmuştur.
    expect(coverage(cards, 'viewsApprox')).toBeGreaterThanOrEqual(0.9);
    expect(coverage(cards, 'publishedAgeDays')).toBeGreaterThanOrEqual(0.9);
    expect(coverage(cards, 'channelId')).toBeGreaterThanOrEqual(0.8);
    // Süre olmadan Kapı 0 videoyu canlı yayın sanıp eler.
    expect(coverage(cards, 'durationSec')).toBeGreaterThanOrEqual(0.9);
    expect(coverage(cards, 'thumbnailUrl')).toBeGreaterThanOrEqual(0.9);
  });

  it.runIf(page !== null)('kartların çoğu yatay video olarak sınıflandırılıyor', () => {
    const cards = page?.cards ?? [];
    const videos = cards.filter((c) => c.kind === 'video');
    expect(videos.length / cards.length).toBeGreaterThanOrEqual(0.5);
    expect(cards.every((c) => c.kind !== 'unknown')).toBe(true);
  });
});

describe('yakalanmış arama tohumu', () => {
  const seeds = load('search-feed', z.array(RawVideoCardSchema));

  it.runIf(seeds !== null)('anonim arama kullanılabilir tohum veriyor', () => {
    // Ana sayfa anonim oturumda boş döndüğü için tohum kaynağımız bu.
    const usable = (seeds ?? []).filter((c) => c.kind === 'video');
    expect(usable.length).toBeGreaterThan(5);
  });
});

describe('yakalanmış kanal anlık görüntüsü', () => {
  const channel = load('channel-snapshot', ChannelSnapshotSchema);

  it.runIf(channel !== null)('abone sayısı metinden sayıya çevriliyor', () => {
    expect(channel?.subsText).toBeTruthy();
    expect(channel?.subsApprox ?? 0).toBeGreaterThan(0);
    expect(channel?.subsHidden).toBe(false);
  });

  it.runIf(channel !== null)('taban çizgisi için yeterli yükleme geçmişi geliyor', () => {
    const uploads = channel?.recentUploads ?? [];
    // Varsayılan taban penceresi 12 video; en az bu kadarı gelmeli.
    expect(uploads.length).toBeGreaterThanOrEqual(12);

    const longform = uploads.filter((u) => u.kind === 'video');
    expect(longform.length).toBeGreaterThanOrEqual(12);
    expect(coverage(longform as unknown as Record<string, unknown>[], 'viewsApprox')).toBe(1);
    expect(coverage(longform as unknown as Record<string, unknown>[], 'publishedAgeDays')).toBe(1);
  });
});

describe('yakalanmış ana sayfa', () => {
  const home = load('home-feed', z.array(RawVideoCardSchema));

  it.runIf(home !== null)('anonim ana sayfanın video vermediği belgelenmiştir', () => {
    // Bu fixture bir başarı değil, bir KANIT: anonim oturumda YouTube ana
    // sayfası video yerine "giriş yap" kartı döndürüyor. Bir gün dolmaya
    // başlarsa bu test kırılır ve tohumlama stratejisini gözden geçiririz.
    expect((home ?? []).filter((c) => c.kind === 'video')).toHaveLength(0);
  });
});
