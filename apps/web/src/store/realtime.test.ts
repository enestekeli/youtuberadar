import type { PoolItem } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { useRealtime, visiblePool } from './realtime.js';

function item(videoId: string, hype: number | null, overrides: Partial<PoolItem> = {}): PoolItem {
  return {
    videoId,
    runId: 'run1',
    title: `video ${videoId}`,
    thumbnailUrl: null,
    durationSec: 600,
    channelId: `UC_${videoId}`,
    channelName: 'Kanal',
    subsText: '10K subscribers',
    subsApprox: 10_000,
    views: 100_000,
    ageDays: 5,
    vpd: 20_000,
    score:
      hype === null
        ? { type: 'pending' }
        : { type: 'hype', value: hype, z: null, lowConfidence: false, lowConfidenceReasons: [] },
    receipts: null,
    channelIsHot: false,
    suspectedBoughtTraffic: false,
    discarded: false,
    depth: 1,
    caughtAt: 1_754_500_000_000,
    ...overrides,
  };
}

function pool(...items: PoolItem[]): Map<string, PoolItem> {
  return new Map(items.map((i) => [i.videoId, i]));
}

/** Kanal avı kartı — skoru bir video çarpanı değil, medyan izlenme/abone. */
const kanalKarti = (videoId: string, value: number, caughtAt: number): PoolItem =>
  item(videoId, null, {
    caughtAt,
    subsApprox: 320_000,
    score: {
      type: 'channel',
      value,
      hitRate: 0.44,
      channelAgeDays: 175,
      uploads: 18,
      lowConfidence: false,
      lowConfidenceReasons: [],
    },
  });

describe('havuz görünümü', () => {
  it('en yeni yakalama başta gelir', () => {
    const p = pool(
      item('orta', 12, { caughtAt: 2000 }),
      item('eski', 40, { caughtAt: 1000 }),
      item('yeni', 3, { caughtAt: 3000 }),
    );
    expect(visiblePool(p).map((i) => i.videoId)).toEqual(['yeni', 'orta', 'eski']);
  });

  it('çöpe atılan kart listede yer almaz', () => {
    const p = pool(item('a', 12), item('cop', 12, { discarded: true }));
    expect(visiblePool(p).map((i) => i.videoId)).toEqual(['a']);
  });

  it('KANAL kartı hiçbir eşiğe takılmaz', () => {
    /*
     * Regresyon. Gerçek vaka: 320B aboneli, 16.5B medyanlı 5 aylık bir kanal.
     * Oranı 0.05 çıkıyor ve görünmeyen 5x çarpan varsayılanı onu sessizce
     * siliyordu — arayüz "yakalandı 5" yazarken havuz boş görünüyordu. Kanal
     * skoru bir video çarpanı değil; artık hiçbir görünüm filtresi de yok.
     */
    const p = pool(item('viral', 40, { caughtAt: 1000 }), kanalKarti('kanal', 0.05, 5000));
    expect(visiblePool(p).map((i) => i.videoId)).toEqual(['kanal', 'viral']);
  });

  it('skoru henüz gelmemiş kart da listede durur', () => {
    // "Skorlanıyor…" kartı kaybolup geri gelirse arayüz titrer.
    expect(visiblePool(pool(item('bekleyen', null)))).toHaveLength(1);
  });

  it('VSR yedek skorlu kart gizlenmez', () => {
    // Eskiden kapatılabilir bir görünüm filtresiydi. Elemeyi tarama zaten
    // yapıyor; ikinci katman kart kaybettirmekten başka iş görmüyordu.
    const p = pool(
      item('v', null, {
        score: {
          type: 'vsr',
          value: 43.9,
          lowConfidence: true,
          lowConfidenceReasons: ['no_baseline'],
        },
      }),
    );
    expect(visiblePool(p)).toHaveLength(1);
  });
});

describe('geçmiş görünümü', () => {
  const canli = () => [item('canli_a', 12), item('canli_b', 8)];
  const arsiv = () => [item('eski_1', 40), item('eski_2', 3)];

  function store() {
    useRealtime.setState({ pool: new Map(canli().map((i) => [i.videoId, i])), livePool: null });
    return useRealtime.getState();
  }

  it('geçmişe girip çıkınca canlı havuz geri gelir', () => {
    /*
     * Regresyon: arşiv görünümü havuzun ÜSTÜNE yazıyor ve eskiden tek yönlüydü.
     * "geçmiş"e yanlışlıkla basan kullanıcı taramanın o ana kadarki sonuçlarını
     * ancak yeni bir tarama başlatarak geri getirebiliyordu.
     */
    store().enterArchive(arsiv());
    expect(
      visiblePool(useRealtime.getState().pool)
        .map((i) => i.videoId)
        .sort(),
    ).toEqual(['eski_1', 'eski_2']);
    expect(useRealtime.getState().archiveMode).toBe(true);

    useRealtime.getState().exitArchive(null);
    expect(
      visiblePool(useRealtime.getState().pool)
        .map((i) => i.videoId)
        .sort(),
    ).toEqual(['canli_a', 'canli_b']);
    expect(useRealtime.getState().archiveMode).toBe(false);
  });

  it('taze liste verilirse yedeğin yerine o kullanılır', () => {
    // Tarama sürerken arşive bakıldıysa yeni yakalamalar yedekte yok; çağıran
    // taraf sunucudan tazesini getiriyor.
    store().enterArchive(arsiv());
    useRealtime.getState().exitArchive([...canli(), item('canli_yeni', 20)]);
    expect(visiblePool(useRealtime.getState().pool)).toHaveLength(3);
  });

  it('arşivdeyken tekrar girmek yedeği EZMEZ', () => {
    store().enterArchive(arsiv());
    useRealtime.getState().enterArchive([item('eski_3', 5)]);
    useRealtime.getState().exitArchive(null);
    expect(
      visiblePool(useRealtime.getState().pool)
        .map((i) => i.videoId)
        .sort(),
    ).toEqual(['canli_a', 'canli_b']);
  });
});
