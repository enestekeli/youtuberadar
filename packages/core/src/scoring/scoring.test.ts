import { DEFAULT_CRAWL_CONFIG } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { makeCard, makeSnapshot, makeUploads } from '../testing/factories.js';
import { computeBaseline } from './baseline.js';
import { MATURITY_FLOOR, MATURITY_HORIZON_DAYS, maturity, projectViews } from './maturity.js';
import { median, medianAbsoluteDeviation, robustLogZScore } from './robust.js';
import { type ScoreOutcome, scoreVideo, suspectsBoughtTraffic } from './score.js';
import { viewsPerDay } from './velocity.js';

const scoreConfig = {
  baselineSize: DEFAULT_CRAWL_CONFIG.baselineSize,
  baselineLookbackDays: DEFAULT_CRAWL_CONFIG.baselineLookbackDays,
  baselineFloor: DEFAULT_CRAWL_CONFIG.baselineFloor,
  baselineMinN: DEFAULT_CRAWL_CONFIG.baselineMinN,
  vsrThreshold: DEFAULT_CRAWL_CONFIG.vsrThreshold,
};

const baselineParams = {
  baselineSize: scoreConfig.baselineSize,
  baselineLookbackDays: scoreConfig.baselineLookbackDays,
  baselineFloor: scoreConfig.baselineFloor,
  baselineMinN: scoreConfig.baselineMinN,
};

/**
 * Tam olgunluk ufkundaki yüklemeler: m(30) = 1 olduğu için projeksiyon ham
 * izlenmeye eşittir ve aşağıdaki testlerin aritmetiği şeffaf kalır.
 *
 * Yaşlar KASITLI olarak eşit (adım 0). Eğri artık 30 günde kelepçelenmediğinden
 * 35/42/49 günlük bir örneklem farklı katsayılarla geri çekilir ve "medyan tam
 * 2000" gibi net iddialar kurulamazdı. Yaş etkisi ayrı testlerde ölçülüyor.
 */
const OLD = { startAgeDays: 30, ageStepDays: 0 };

function must<T>(value: T | null | undefined, message = 'değer boş olmamalıydı'): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function scored(outcome: ScoreOutcome) {
  if (outcome.kind !== 'scored') throw new Error('skorlanması bekleniyordu');
  return outcome.score;
}

describe('robust istatistikler', () => {
  it('medyan tek ve çift uzunlukta doğru', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('boş dizide null döner — sıfırla karıştırılmaz', () => {
    expect(median([])).toBeNull();
    expect(medianAbsoluteDeviation([], 0)).toBeNull();
  });

  it('tüm örnekler aynıysa z-skoru null (sapma uydurulmaz)', () => {
    expect(robustLogZScore(5000, [1000, 1000, 1000, 1000, 1000])).toBeNull();
  });

  it('dağılım varsa outlier yüksek z alır', () => {
    expect(must(robustLogZScore(200_000, [1000, 1400, 900, 2200, 1700, 1100]))).toBeGreaterThan(3);
  });
});

describe('olgunluk (yaş normalizasyonu)', () => {
  it('30. günde tam olgunluk', () => {
    expect(maturity(MATURITY_HORIZON_DAYS)).toBe(1);
    expect(projectViews(12_345, 30)).toBe(12_345);
  });

  it('30 günden yaşlı video 30. gün değerine GERİ çekilir', () => {
    // Eğri 30 günde kelepçelenirse, 300 günde biriken izlenme "30 günlük değer"
    // sayılır ve eski videolar taze olanları haksız yere ezer.
    expect(maturity(90)).toBeGreaterThan(1);
    expect(projectViews(12_345, 90)).toBeLessThan(12_345);

    // Yaş büyüdükçe geri çekme artar ama logaritmik olarak frenlenir.
    expect(maturity(365)).toBeCloseTo(2.0, 1);
    expect(maturity(3650)).toBeLessThan(3.5);
  });

  it('aynı izlenme, yaşlı videoda daha düşük projeksiyon üretir', () => {
    // Çarpanın anlamı budur: 500 günde 1M izlenme, 30 günde 1M izlenmeyle
    // aynı başarı değildir.
    expect(projectViews(1_000_000, 500)).toBeLessThan(projectViews(1_000_000, 30));
  });

  it('monoton artar (30 günden sonra da)', () => {
    let prev = 0;
    for (const t of [0.5, 1, 2, 3, 7, 14, 21, 30, 60, 180, 365]) {
      const m = maturity(t);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  it('çok genç videolarda taban devreye girer (absürt projeksiyon yok)', () => {
    expect(maturity(0.01)).toBe(MATURITY_FLOOR);
    expect(projectViews(1000, 0.25) / 1000).toBeLessThanOrEqual(1 / MATURITY_FLOOR);
  });
});

describe('izlenme hızı', () => {
  it('yarım günlük taban çok genç videoyu sonsuza taşımaz', () => {
    expect(viewsPerDay(1000, 0)).toBe(2000);
    expect(viewsPerDay(3000, 3)).toBe(1000);
  });
});

describe('taban çizgisi', () => {
  it('kanalın önceki viral videosu tabanı zehirlemez (medyan ≠ ortalama)', () => {
    const uploads = makeUploads([2000, 2000, 2000, 100_000, 2000, 2000, 2000, 2000], OLD);
    const baseline = must(computeBaseline('aday', 30, uploads, baselineParams));
    expect(baseline.value).toBe(2000);

    // Aynı veriyle ortalama alsaydık taban 14.250 olurdu — 20k izlenmeli bir hit
    // 1.4 kat görünüp radara hiç düşmezdi.
    const mean = uploads.reduce((sum, u) => sum + (u.viewsApprox ?? 0), 0) / uploads.length;
    expect(20_000 / mean).toBeLessThan(2);
    expect(20_000 / baseline.value).toBe(10);
  });

  it('aday kendi taban çizgisine dahil edilmez', () => {
    const uploads = makeUploads([2000, 2000, 2000, 2000, 2000], OLD);
    const self = makeCard({ videoId: 'aday', viewsApprox: 500_000, publishedAgeDays: 30 });
    const baseline = must(computeBaseline('aday', 30, [self, ...uploads], baselineParams));
    expect(baseline.value).toBe(2000);
    expect(baseline.samples).not.toContain(500_000);
  });

  it('adaydan SONRA yayımlanan videolar tabana katılmaz (geriye dönük)', () => {
    // Viral videodan sonra kanal büyüdü: sonraki videolar 80k izlendi.
    const after = makeUploads([80_000, 80_000, 80_000], { startAgeDays: 5, ageStepDays: 5 });
    const before = makeUploads([2000, 2000, 2000, 2000, 2000], OLD);
    const baseline = must(computeBaseline('aday', 30, [...after, ...before], baselineParams));
    expect(baseline.n).toBe(5);
    expect(baseline.value).toBe(2000);
  });

  it('Shorts taban çizgisinden yapısal olarak dışlanır', () => {
    const shorts = makeUploads([500_000, 500_000, 500_000], { ...OLD, kind: 'short' });
    const longform = makeUploads([2000, 2000, 2000, 2000, 2000], OLD);
    const baseline = must(computeBaseline('aday', 30, [...shorts, ...longform], baselineParams));
    expect(baseline.n).toBe(5);
    expect(baseline.value).toBe(2000);
  });

  it('okunamayan metrikli yüklemeler sessizce sıfır sayılmaz, atlanır', () => {
    const broken = makeUploads([2000, 2000], OLD).map((u) => ({ ...u, viewsApprox: null }));
    const ok = makeUploads([2000, 2000, 2000, 2000, 2000], OLD);
    const baseline = must(computeBaseline('aday', 30, [...broken, ...ok], baselineParams));
    expect(baseline.n).toBe(5);
  });

  it('örneklem minimumun altındaysa taban üretilmez', () => {
    const uploads = makeUploads([2000, 2000, 2000, 2000], OLD);
    expect(computeBaseline('aday', 30, uploads, baselineParams)).toBeNull();
  });

  it('lookback penceresi dışındaki eski yüklemeler sayılmaz', () => {
    const ancient = makeUploads([9_000_000], { startAgeDays: 500, ageStepDays: 1 });
    const recent = makeUploads([2000, 2000, 2000, 2000, 2000], OLD);
    const baseline = must(computeBaseline('aday', 30, [...ancient, ...recent], baselineParams));
    expect(baseline.n).toBe(5);
  });
});

describe('scoreVideo', () => {
  it('normal durumda hype üretir, VSR null kalır', () => {
    const snapshot = makeSnapshot({
      recentUploads: makeUploads([2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000], OLD),
    });
    const score = scored(
      scoreVideo({ videoId: 'aday', views: 20_000, ageDays: 30 }, snapshot, scoreConfig),
    );
    expect(score.scoreType).toBe('hype');
    expect(score.hype).toBeCloseTo(10, 5);
    expect(score.vsr).toBeNull();
    expect(score.lowConfidence).toBe(false);
    expect(score.baselineN).toBe(8);
  });

  it('taban tabanı (floor) minik kanallarda çarpan enflasyonunu keser', () => {
    const snapshot = makeSnapshot({
      recentUploads: makeUploads([150, 150, 150, 150, 150, 150, 150, 150], OLD),
    });
    const score = scored(
      scoreVideo({ videoId: 'aday', views: 15_000, ageDays: 30 }, snapshot, scoreConfig),
    );
    expect(15_000 / 150).toBe(100); // tabansız absürt çarpan
    expect(score.hype).toBeCloseTo(15_000 / DEFAULT_CRAWL_CONFIG.baselineFloor, 5);
    expect(score.lowConfidence).toBe(true);
  });

  it('ince geçmişte (n≤7) çarpan abone oranıyla frenlenir', () => {
    const snapshot = makeSnapshot({
      subsApprox: 12_000,
      recentUploads: makeUploads([1000, 1000, 1000, 1000, 1000], OLD),
    });
    const score = scored(
      scoreVideo({ videoId: 'aday', views: 100_000, ageDays: 30 }, snapshot, scoreConfig),
    );
    // Frensiz 100 kat olurdu; 2 × (100k/12k) = 16.67 ile sınırlanır.
    expect(score.hype).toBeCloseTo((2 * 100_000) / 12_000, 4);
    expect(score.lowConfidence).toBe(true);
  });

  it('kanal geçmişi yoksa VSR yedeğine düşer ve ayrı kolonda kalır', () => {
    const snapshot = makeSnapshot({ subsApprox: 12_000, recentUploads: [] });
    const score = scored(
      scoreVideo({ videoId: 'aday', views: 50_000, ageDays: 30 }, snapshot, scoreConfig),
    );
    expect(score.scoreType).toBe('vsr');
    expect(score.hype).toBeNull();
    expect(score.vsr).toBeCloseTo(50_000 / 12_000, 5);
    expect(score.lowConfidence).toBe(true);
  });

  it('çok küçük kanallarda VSR abone tabanıyla sınırlanır', () => {
    const snapshot = makeSnapshot({ subsApprox: 50, recentUploads: [] });
    const score = scored(
      scoreVideo({ videoId: 'aday', views: 50_000, ageDays: 30 }, snapshot, scoreConfig),
    );
    expect(score.vsr).toBeCloseTo(50, 5);
  });

  it('ne taban ne abone varsa skor uydurulmaz', () => {
    const snapshot = makeSnapshot({ subsApprox: null, subsHidden: true, recentUploads: [] });
    const out = scoreVideo({ videoId: 'aday', views: 50_000, ageDays: 30 }, snapshot, scoreConfig);
    expect(out.kind).toBe('insufficient');
  });

  it('genç video yaş normalizasyonuyla hak ettiği çarpanı alır', () => {
    const uploads = makeUploads(
      [20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000],
      OLD,
    );
    const snapshot = makeSnapshot({ recentUploads: uploads });
    // 3 günde 20k izlenme, kanalın olgun medyanı da 20k: ham kıyas 1.0x derdi.
    const score = scored(
      scoreVideo({ videoId: 'aday', views: 20_000, ageDays: 3 }, snapshot, scoreConfig),
    );
    expect(must(score.hype)).toBeGreaterThan(3);
    expect(score.hype).toBeCloseTo(1 / maturity(3), 4);
  });

  it('eski video, aynı izlenmeye sahip taze videoyu geçemez', () => {
    /*
     * Canlı veride ölçülen bozukluk: eğri 30 günde kelepçelendiği için 334
     * günlük bir video, on bir ayda biriktirdiği izlenmeyi "30 günlük değeri"
     * sayıp bir aylık videoyla aynı kefeye giriyordu. Havuzun %43'ü 30 günden
     * yaşlıydı; şişme ortalama 1.35x, en yaşlılarda 2.0x'ti ve yaş filtresi
     * kaldırıldığında ilk 10 sıralamasının 4'ünü bozuyordu.
     */
    const uploads = makeUploads([2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000], OLD);
    const snapshot = makeSnapshot({ recentUploads: uploads });

    const taze = scored(
      scoreVideo({ videoId: 'taze', views: 200_000, ageDays: 30 }, snapshot, scoreConfig),
    );
    const eski = scored(
      scoreVideo({ videoId: 'eski', views: 200_000, ageDays: 334 }, snapshot, scoreConfig),
    );

    expect(must(eski.hype)).toBeLessThan(must(taze.hype));
    // Bir yıllık video kabaca yarı değerine çekilir: m(365) ≈ 2.
    expect(must(taze.hype) / must(eski.hype)).toBeCloseTo(maturity(334), 3);
  });

  it('altın yıldız: kanalın tipik izlenmesi abone sayısını aşıyor', () => {
    const uploads = makeUploads(
      [30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000],
      OLD,
    );
    const hot = makeSnapshot({ subsApprox: 5000, recentUploads: uploads });
    const cold = makeSnapshot({ subsApprox: 500_000, recentUploads: uploads });
    const input = { videoId: 'aday', views: 300_000, ageDays: 30 };
    expect(scored(scoreVideo(input, hot, scoreConfig)).channelIsHot).toBe(true);
    expect(scored(scoreVideo(input, cold, scoreConfig)).channelIsHot).toBe(false);
  });

  it('gizli abone sayısı hype yolunu engellemez', () => {
    const snapshot = makeSnapshot({
      subsApprox: null,
      subsHidden: true,
      recentUploads: makeUploads([2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000], OLD),
    });
    const score = scored(
      scoreVideo({ videoId: 'aday', views: 20_000, ageDays: 30 }, snapshot, scoreConfig),
    );
    expect(score.scoreType).toBe('hype');
    expect(score.hype).toBeCloseTo(10, 5);
    expect(score.channelIsHot).toBe(false);
  });
});

describe('satın alınmış trafik şüphesi', () => {
  it('1000 izlenmede 1.5 beğeninin altı şüpheli', () => {
    expect(suspectsBoughtTraffic(100, 100_000)).toBe(true);
    expect(suspectsBoughtTraffic(3000, 100_000)).toBe(false);
  });

  it('beğeni bilinmiyorsa ya da izlenme çok azsa bayrak kalkmaz', () => {
    expect(suspectsBoughtTraffic(null, 100_000)).toBe(false);
    expect(suspectsBoughtTraffic(0, 500)).toBe(false);
  });
});

describe('geriye dönük örneklem yetersizliği', () => {
  it('sık yükleyen kanalda ana metrik korunur, sonuç düşük güvenli işaretlenir', () => {
    // Canlı testte bulundu: kanalın son 30 videosunu çekiyoruz; sık yükleyen bir
    // kanalda hepsi 12 günlük adaydan yeni olabiliyordu ve geriye dönük örneklem
    // boş kalıp zayıf VSR yedeğine düşülüyordu.
    const newerOnly = makeUploads([5000, 5000, 5000, 5000, 5000, 5000], {
      startAgeDays: 1,
      ageStepDays: 1,
    });
    const baseline = must(computeBaseline('aday', 12, newerOnly, baselineParams));
    expect(baseline.usedNewerUploads).toBe(true);
    expect(baseline.n).toBe(6);
    // Yüklemeler 1–6 günlük olduğu için tabanları 30 günlük eşdeğerine yansıtılır;
    // ham 5000 izlenme çok daha yükseğe karşılık gelir.
    expect(baseline.value).toBeGreaterThan(5000);

    const snapshot = makeSnapshot({ subsApprox: 2500, recentUploads: newerOnly });
    const score = scored(
      scoreVideo({ videoId: 'aday', views: 97_000, ageDays: 12 }, snapshot, scoreConfig),
    );
    // Ana metrik (medyan çarpanı) korundu; VSR yedeğine düşmedik.
    expect(score.scoreType).toBe('hype');
    expect(score.lowConfidence).toBe(true);
  });

  it('yeterli geriye dönük örneklem varsa yeniler kullanılmaz', () => {
    const after = makeUploads([80_000, 80_000], { startAgeDays: 2, ageStepDays: 2 });
    const before = makeUploads([2000, 2000, 2000, 2000, 2000], OLD);
    const baseline = must(computeBaseline('aday', 30, [...after, ...before], baselineParams));
    expect(baseline.usedNewerUploads).toBe(false);
    expect(baseline.value).toBe(2000);
  });
});
