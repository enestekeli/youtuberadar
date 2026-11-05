import type { RawVideoCard } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import {
  type ChannelInput,
  type Classification,
  ClassificationSchema,
  crowding,
  durationFit,
  evaluateChannel,
  sortRows,
} from './kanal-listesi.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5);

function card(i: number, views: number, overrides: Partial<RawVideoCard> = {}): RawVideoCard {
  return {
    videoId: `v${i}`,
    title: `Every Type of Machine Explained part ${i}`,
    channelId: 'UCtest',
    channelName: 'Test',
    kind: 'video',
    durationSec: 25 * 60,
    viewsApprox: views,
    publishedAgeDays: 3 + i * 2,
    thumbnailUrl: null,
    sourceNodeType: 'videoRenderer',
    ...overrides,
  };
}

function channel(uploads: RawVideoCard[], overrides: Partial<ChannelInput> = {}): ChannelInput {
  return {
    channelId: 'UCtest',
    name: 'Machine Atlas',
    handle: null,
    subs: 40_000,
    country: null,
    joinedAt: NOW - 90 * DAY,
    channelAgeDaysAtCatch: null,
    caughtAt: NOW,
    snapshotFetchedAt: NOW,
    uploads,
    seedQuery: 'every type of machine explained',
    ...overrides,
  };
}

const steady = (views = 60_000) => Array.from({ length: 12 }, (_, i) => card(i, views));
const good: Classification = {
  kategori: 'anlatimli_belgesel',
  alt_nis: 'every type teknoloji',
  uretilebilirlik: 5,
  formul_benzerligi: 4,
  gorsel_tipi: 'sabit_gorsel',
};

describe('kanal listesi — bizim sistem durumları', () => {
  it('istikrarlı, genç, uzun videolu kanal aday', () => {
    const row = evaluateChannel(channel(steady()), good, NOW);
    expect(row.status).toBe('aday');
    expect(row.medianRecent).toBe(60_000);
    expect(row.durationFit).toBe('tam');
    expect(row.priority).toBe(5 + 4 + 2);
  });

  it('kısa klipler ölçüme girmez; uzun video azsa izlemede', () => {
    const uploads = [
      ...Array.from({ length: 10 }, (_, i) => card(i, 900_000, { durationSec: 120 })),
      ...Array.from({ length: 3 }, (_, i) => card(20 + i, 30_000)),
    ];
    const row = evaluateChannel(channel(uploads), good, NOW);
    expect(row.longCount).toBe(3);
    expect(row.medianRecent).toBe(30_000);
    expect(row.status).toBe('izlemede');
    expect(row.reason).toContain('uzun video');
  });

  it('medyan 20 B altı aday olmaz ("20 B için kanal kurdurma")', () => {
    const row = evaluateChannel(channel(steady(12_000)), good, NOW);
    expect(row.status).toBe('izlemede');
    expect(row.reason).toContain('medyan 12 B');
  });

  it('AI video görsel tavanıyla elenir', () => {
    const row = evaluateChannel(channel(steady()), { ...good, gorsel_tipi: 'ai_video' }, NOW);
    expect(row.producibility).toBe(1);
    expect(row.status).toBe('elendi');
    expect(row.reason).toBe('üretilemez: ai_video');
  });

  it('6 aydan eski kanal elenir', () => {
    const row = evaluateChannel(channel(steady(), { joinedAt: NOW - 400 * DAY }), good, NOW);
    expect(row.status).toBe('elendi');
    expect(row.reason).toContain('400 günlük');
  });

  it('uyku formatı ve yasak türler elenir', () => {
    const sleep = steady().map((u) => ({
      ...u,
      title: `8 Hours of Ancient Rome for Sleep ${u.videoId}`,
    }));
    expect(evaluateChannel(channel(sleep), undefined, NOW).status).toBe('elendi');
    const crime = steady().map((u) => ({ ...u, title: `True Crime Case ${u.videoId}` }));
    expect(evaluateChannel(channel(crime), undefined, NOW).reason).toBe('yasak tür: true crime');
  });

  it('tek tük yasak kelime kanalı elemez', () => {
    const uploads = steady();
    uploads[0] = { ...card(0, 60_000), title: 'The News That Changed Rome' };
    expect(evaluateChannel(channel(uploads), good, NOW).status).toBe('aday');
  });

  it('Hint içeriği elenir', () => {
    const uploads = steady().map((u) => ({ ...u, title: `मशीन का इतिहास ${u.videoId}` }));
    expect(evaluateChannel(channel(uploads), good, NOW).reason).toBe('Hint içeriği');
  });

  it('sönen kanal izlemede (son 5 / önceki 5 < 0,3)', () => {
    const uploads = [
      ...Array.from({ length: 5 }, (_, i) => card(i, 25_000)),
      ...Array.from({ length: 5 }, (_, i) => card(5 + i, 200_000)),
    ];
    const row = evaluateChannel(channel(uploads), good, NOW);
    expect(row.momentum).toBeCloseTo(0.125, 3);
    expect(row.flags).toContain('sönüyor');
    expect(row.status).toBe('izlemede');
  });

  it('tek vuruş: büyük vuruştan sonra sönen kanal işaretlenir', () => {
    const uploads = [...Array.from({ length: 9 }, (_, i) => card(i, 20_000)), card(9, 2_000_000)];
    const row = evaluateChannel(channel(uploads), good, NOW);
    expect(row.flags).toContain('tek vuruş');
    expect(row.status).toBe('izlemede');
  });

  it('büyük vuruşu olan sağlam kanal tek vuruş sayılmaz (The Last Day vakası)', () => {
    // Son videolar ~450 B, en iyisi 5,1 M: en iyinin %9'u — sağlam bir model.
    const uploads = [
      ...Array.from({ length: 9 }, (_, i) => card(i, 450_000 + i * 30_000)),
      card(9, 5_100_000),
    ];
    const row = evaluateChannel(channel(uploads), good, NOW);
    expect(row.flags).not.toContain('tek vuruş');
    expect(row.status).toBe('aday');
  });

  it('bizim kanal referans olur', () => {
    const row = evaluateChannel(
      channel(steady(5000), { channelId: 'UCGH1GXDCNTTHkhPiLBQ3sLw' }),
      undefined,
      NOW,
    );
    expect(row.status).toBe('referans');
  });

  it('anlık görüntü yaşları bugüne taşınır', () => {
    const uploads = [card(0, 50_000, { publishedAgeDays: 1 })];
    // Görüntü 10 gün önce alındı: 1 günlük video bugün 11 günlük, medyana girer.
    const row = evaluateChannel(channel(uploads, { snapshotFetchedAt: NOW - 10 * DAY }), good, NOW);
    expect(row.medianRecent).toBe(50_000);
    expect(row.uploads30).toBe(1);
  });

  it('sıralama durum → öncelik; kalabalık alt niş sayılır', () => {
    const a = evaluateChannel(channel(steady()), good, NOW);
    const b = evaluateChannel(
      channel(steady(), { channelId: 'UCb' }),
      { ...good, formul_benzerligi: 1 },
      NOW,
    );
    const c = evaluateChannel(channel(steady(5000), { channelId: 'UCc' }), good, NOW);
    expect(sortRows([c, b, a]).map((r) => r.channelId)).toEqual(['UCtest', 'UCb', 'UCc']);
    expect(crowding([a, b, c]).get('every type teknoloji')).toBe(3);
  });

  it('süre uyumu bizim hattın aralığına göre', () => {
    expect(durationFit(25).label).toBe('tam');
    expect(durationFit(12).label).toBe('orta');
    expect(durationFit(90).label).toBe('düşük');
  });

  it('sınıflama şeması eski siniflama.json girdilerini kabul eder', () => {
    const eski = {
      UCx: { kategori: 'kisa_dizi_drama', alt_nis: 'TV', uretilebilirlik: 0, formul_benzerligi: 0 },
      UCy: {
        kategori: 'anlatimli_belgesel',
        uretilebilirlik: 4,
        formul_benzerligi: 3,
        gorsel_tipi: 'karisik',
        not: '[2026-11-03 puanlama]',
      },
    };
    expect(ClassificationSchema.safeParse(eski).success).toBe(true);
  });
});
