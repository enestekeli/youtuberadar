import type { ChannelSnapshot, RawVideoCard } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { makeCard, makeSnapshot } from '../testing/factories.js';
import { channelScoreValue, scoreChannel } from './channel-score.js';

const config = { minChannelUploads: 4 };

/** Belirtilen izlenmelerle, hepsi yeterince yaşlı yüklemeler. */
function uploads(views: (number | null)[], ageDays = 10): RawVideoCard[] {
  return views.map((v, i) =>
    makeCard({
      videoId: `up_${i}`,
      viewsApprox: v,
      publishedAgeDays: ageDays + i,
    }),
  );
}

function channel(views: (number | null)[], overrides: Partial<ChannelSnapshot> = {}) {
  return makeSnapshot({ subsApprox: 5000, recentUploads: uploads(views), ...overrides });
}

function scored(snapshot: ChannelSnapshot) {
  const out = scoreChannel(snapshot, config);
  if (out.kind !== 'scored') throw new Error(`skorlanması bekleniyordu, ${out.kind} geldi`);
  return out.score;
}

describe('kanal istikrarı', () => {
  it('isabet oranını ve medyanı hesaplar', () => {
    // 5000 abone; 10 videonun 8'i aboneyi aşıyor.
    const score = scored(
      channel([60_000, 55_000, 50_000, 45_000, 40_000, 35_000, 30_000, 25_000, 900, 800]),
    );
    expect(score.n).toBe(10);
    expect(score.hits).toBe(8);
    expect(score.hitRate).toBeCloseTo(0.8, 5);
    expect(score.medianViews).toBe(37_500);
    expect(score.medianVsr).toBeCloseTo(7.5, 5);
    expect(score.lowConfidence).toBe(false);
  });

  it('temsilci en çok izlenen video, eşitlikte daha yeni olan', () => {
    const snapshot = makeSnapshot({
      subsApprox: 5000,
      recentUploads: [
        makeCard({ videoId: 'orta', viewsApprox: 40_000, publishedAgeDays: 10 }),
        makeCard({ videoId: 'eski_tepe', viewsApprox: 90_000, publishedAgeDays: 30 }),
        makeCard({ videoId: 'yeni_tepe', viewsApprox: 90_000, publishedAgeDays: 5 }),
        makeCard({ videoId: 'dip', viewsApprox: 20_000, publishedAgeDays: 12 }),
      ],
    });
    const ids = scored(snapshot).representatives.map((r) => r.videoId);
    expect(ids).toEqual(['yeni_tepe', 'eski_tepe', 'orta', 'dip']);
  });

  it('isabet TEK bacak: mutlak taban artık burada değil', () => {
    /*
     * 200 aboneli kanal, videoları 5000 izlenme. Eskiden ikinci bir bacak
     * (izlenme ≥ 10K) vardı ve bunlar "isabetsiz" sayılırdı. Artık mutlak
     * izlenme kararı kanalın MEDYANINA, motordaki tek kapıda uygulanıyor —
     * bu oran yalnızca "abonesini aşıyor mu" sorusunu yanıtlıyor.
     */
    const score = scored(channel([5000, 5000, 5000, 5000], { subsApprox: 200 }));
    expect(score.hits).toBe(4);
    expect(score.medianViews).toBe(5000);
  });

  it('abonesinin altında kalan videolar isabet değildir', () => {
    // 500B aboneli kanal, videoları 20K: bu kanal düşüşte, yükseliyor değil.
    const score = scored(channel([20_000, 20_000, 20_000, 20_000], { subsApprox: 500_000 }));
    expect(score.hits).toBe(0);
  });

  it('sınırda eşitlik isabet sayılır', () => {
    const score = scored(channel([10_000, 10_000, 10_000, 10_000], { subsApprox: 10_000 }));
    expect(score.hits).toBe(4);
  });

  it('okunamayan izlenme paydadan DÜŞER, asla 0 sayılmaz', () => {
    /*
     * Projenin en eski ilkesi (`text-parse.ts`): okunamayan bir değer
     * varsayılana kıvrılmaz. Null izlenmeleri 0 saysaydık kanalın isabet oranı
     * ayrıştırıcı hatası yüzünden düşerdi — yani YouTube arayüzü değiştiğinde
     * sonuçlar sessizce kötüleşirdi.
     */
    const score = scored(channel([50_000, null, 40_000, null, 30_000, 25_000]));
    expect(score.n).toBe(4);
    expect(score.hits).toBe(4);
    expect(score.hitRate).toBe(1);
  });

  it('Shorts ve canlı yayınlar sayılmaz', () => {
    const snapshot = makeSnapshot({
      subsApprox: 5000,
      recentUploads: [
        ...uploads([50_000, 40_000, 30_000, 20_000]),
        makeCard({ videoId: 's1', kind: 'short', viewsApprox: 900_000, publishedAgeDays: 10 }),
        makeCard({ videoId: 'l1', kind: 'live', viewsApprox: 800_000, publishedAgeDays: 10 }),
      ],
    });
    const score = scored(snapshot);
    expect(score.n).toBe(4);
    expect(score.representatives.map((r) => r.videoId)).not.toContain('s1');
  });

  it('izlenmesi oturmamış taze yükleme paydaya girmez', () => {
    const snapshot = makeSnapshot({
      subsApprox: 5000,
      recentUploads: [
        ...uploads([50_000, 40_000, 30_000, 20_000]),
        // Dün yüklenmiş: abonesini aşmamış olması kanal hakkında bilgi değil.
        makeCard({ videoId: 'dun', viewsApprox: 300, publishedAgeDays: 1 }),
      ],
    });
    expect(scored(snapshot).n).toBe(4);
  });

  it('yükleme sayısı yetersizse skor üretilmez', () => {
    const out = scoreChannel(channel([50_000, 40_000, 30_000]), config);
    expect(out.kind).toBe('insufficient');
    if (out.kind === 'insufficient') expect(out.reason).toBe('channel_too_few_uploads');
  });

  it('ince örneklem düşük güvenle işaretlenir', () => {
    const score = scored(channel([50_000, 40_000, 30_000, 20_000]));
    expect(score.lowConfidenceReasons).toContain('few_uploads');
    expect(score.lowConfidence).toBe(true);
  });
});

describe('gizli abone', () => {
  const gizli = { subsApprox: null, subsHidden: true };

  it('isabet ölçülemez — uydurulmaz, 0 kalır ve işaretlenir', () => {
    /*
     * Abone bilinmeden "izlenme ≥ abone" sorusu yanıtlanamaz. Bir sayı
     * uydurmak yerine 0 bırakılıyor; kanalın gerçek kapısı olan medyan
     * izlenme ise abone bilgisine hiç ihtiyaç duymadan ölçülüyor.
     */
    const score = scored(channel([50_000, 40_000, 30_000, 900], gizli));
    expect(score.hits).toBe(0);
    expect(score.medianViews).toBe(35_000);
    expect(score.medianVsr).toBeNull();
    expect(score.lowConfidenceReasons).toContain('subs_hidden');
  });

  it('çarpan yine de bir değer üretir (DB CHECK kısıtı için)', () => {
    // `videos_score_present` CHECK'i hype ya da vsr kolonlarından birinin dolu
    // olmasını istiyor; gizli abonede abone tabanına düşüyoruz.
    const score = scored(channel([50_000, 40_000, 30_000, 20_000], gizli));
    expect(channelScoreValue(score)).toBeGreaterThan(0);
    expect(Number.isFinite(channelScoreValue(score))).toBe(true);
  });

  it('abone biliniyorsa çarpan medyan VSR’dir', () => {
    const score = scored(channel([50_000, 50_000, 50_000, 50_000], { subsApprox: 5000 }));
    expect(channelScoreValue(score)).toBeCloseTo(10, 5);
  });
});
