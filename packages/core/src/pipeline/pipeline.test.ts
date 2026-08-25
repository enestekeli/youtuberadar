import { DEFAULT_CRAWL_CONFIG, type RawVideoCard } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { makeCard, makeSnapshot, makeUploads } from '../testing/factories.js';
import { evaluateFreeGates, gateSubscriberRange } from './gates.js';
import { type ChannelResolution, runPipeline } from './pipeline.js';

const config = DEFAULT_CRAWL_CONFIG;
const never = () => false;
const OLD = { startAgeDays: 35, ageStepDays: 7 };

function freeGate(card: RawVideoCard, isSeen: (id: string) => boolean = never) {
  return evaluateFreeGates(card, config, isSeen);
}

describe('Kapı 0 — biçim', () => {
  it.each([
    ['short', 'shorts'],
    ['live', 'live'],
    ['upcoming', 'upcoming'],
    ['mix', 'mix_playlist'],
    ['playlist', 'mix_playlist'],
    ['movie', 'movie'],
    ['unknown', 'unknown_kind'],
  ] as const)('%s türü elenir (%s)', (kind, reason) => {
    const result = freeGate(makeCard({ kind }));
    expect(result.kind).toBe('skip');
    if (result.kind !== 'skip') return;
    expect(result.stage).toBe('shape');
    expect(result.reason).toBe(reason);
  });

  it('3 dakikalık YATAY video elenmez — süre tek başına Shorts kanıtı değil', () => {
    // Ekim 2024 sonrası Shorts sınırı 3 dakika; süreye bakıp elemek gerçek
    // yatay videoları kaybettirirdi. Shorts kararı adaptördeki node tipinden gelir.
    const result = freeGate(makeCard({ kind: 'video', durationSec: 170, viewsApprox: 50_000 }));
    expect(result.kind).toBe('pass');
  });

  it('kanal kimliği olmayan kart skorlanamaz', () => {
    const result = freeGate(makeCard({ channelId: null }));
    expect(result.kind === 'skip' && result.reason).toBe('parse_error');
  });

  it('süresi olmayan video canlı yayın imzasıdır', () => {
    const result = freeGate(makeCard({ durationSec: null }));
    expect(result.kind === 'skip' && result.reason).toBe('live');
  });

  it('daha önce görülen video tekrar işlenmez', () => {
    const result = freeGate(makeCard({ videoId: 'gorulmus' }), (id) => id === 'gorulmus');
    expect(result.kind === 'skip' && result.reason).toBe('seen');
  });
});

describe('Kapı 1 — sayısal ön filtre', () => {
  it('okunamayan izlenme sıfır sayılmaz, ayrı sebeple sayılır', () => {
    const result = freeGate(makeCard({ viewsApprox: null }));
    expect(result.kind === 'skip' && result.reason).toBe('unparseable_metrics');
  });

  it('okunamayan yaş de aynı şekilde ayrı sayılır', () => {
    const result = freeGate(makeCard({ publishedAgeDays: null }));
    expect(result.kind === 'skip' && result.reason).toBe('unparseable_metrics');
  });

  it('yaş penceresinin dışı elenir', () => {
    expect(freeGate(makeCard({ publishedAgeDays: 45 })).kind === 'skip').toBe(true);
    const old = freeGate(makeCard({ publishedAgeDays: 45 }));
    expect(old.kind === 'skip' && old.reason).toBe('age_too_old');

    // 6 saatlik video: projeksiyonu absürt olur, beklemeye bırakılır.
    const young = freeGate(makeCard({ publishedAgeDays: 0.25 }));
    expect(young.kind === 'skip' && young.reason).toBe('age_too_young');
  });

  it('düşük izlenme ve düşük hız elenir', () => {
    const lowViews = freeGate(makeCard({ viewsApprox: 500 }));
    expect(lowViews.kind === 'skip' && lowViews.reason).toBe('views_too_low');

    // 30 günde 10k izlenme = günde 333 → hız eşiğinin altında.
    const slow = freeGate(makeCard({ viewsApprox: 10_000, publishedAgeDays: 30 }));
    expect(slow.kind === 'skip' && slow.reason).toBe('vpd_too_low');
  });

  it('geçen aday sayısal alanları dolu olarak taşır', () => {
    const result = freeGate(makeCard({ viewsApprox: 60_000, publishedAgeDays: 3 }));
    expect(result.kind).toBe('pass');
    if (result.kind !== 'pass') return;
    expect(result.candidate.views).toBe(60_000);
    expect(result.candidate.ageDays).toBe(3);
    expect(result.candidate.vpd).toBe(20_000);
    expect(result.candidate.channelId).toBe('UC_test');
  });
});

describe('Kapı 3 — abone aralığı', () => {
  it('aralık dışı kanal elenir', () => {
    expect(gateSubscriberRange(makeSnapshot({ subsApprox: 2_000_000 }), config)).not.toBeNull();
    expect(gateSubscriberRange(makeSnapshot({ subsApprox: 50 }), config)).not.toBeNull();
  });

  it('aralık içi kanal geçer', () => {
    expect(gateSubscriberRange(makeSnapshot({ subsApprox: 12_000 }), config)).toBeNull();
  });

  it('gizli abone sayısı REDDEDİLMEZ — kanal yine de skorlanabilir', () => {
    const hidden = makeSnapshot({ subsApprox: null, subsHidden: true });
    expect(gateSubscriberRange(hidden, config)).toBeNull();
  });
});

describe('runPipeline', () => {
  const resolver = (resolution: ChannelResolution) => async (): Promise<ChannelResolution> =>
    resolution;

  const healthyChannel = makeSnapshot({
    subsApprox: 12_000,
    recentUploads: makeUploads([2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000], OLD),
  });

  it('gerçek bir outlier yakalanır', async () => {
    const result = await runPipeline(makeCard({ viewsApprox: 50_000, publishedAgeDays: 5 }), {
      config,
      isSeen: never,
      resolveCountry: async () => null,
      resolveChannel: resolver({ kind: 'snapshot', snapshot: healthyChannel, cacheHit: false }),
    });
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.score.scoreType).toBe('hype');
    expect(result.score.hype ?? 0).toBeGreaterThan(config.crawlThreshold);
    expect(result.cacheHit).toBe(false);
  });

  it('eşiğin altındaki video havuza girmez', async () => {
    // Kanalın normali de 20k: bu video sıradan, hype ≈ 1.
    const ordinary = makeSnapshot({
      subsApprox: 12_000,
      recentUploads: makeUploads([20_000, 20_000, 20_000, 20_000, 20_000, 20_000], OLD),
    });
    const result = await runPipeline(makeCard({ viewsApprox: 20_000, publishedAgeDays: 30 }), {
      config,
      isSeen: never,
      resolveCountry: async () => null,
      resolveChannel: resolver({ kind: 'snapshot', snapshot: ordinary, cacheHit: true }),
    });
    expect(result.kind === 'skipped' && result.reason).toBe('below_threshold');
    if (result.kind !== 'skipped') return;
    expect(result.score?.scoreType).toBe('hype');
    expect(result.score?.hype ?? Number.POSITIVE_INFINITY).toBeLessThan(config.crawlThreshold);
    expect(result.score?.baselineSamples.length).toBeGreaterThan(0);
  });

  it('ücretsiz kapılarda elenen video kanal isteği harcatmaz', async () => {
    let resolveCalls = 0;
    const result = await runPipeline(makeCard({ kind: 'short' }), {
      config,
      isSeen: never,
      resolveCountry: async () => null,
      resolveChannel: async () => {
        resolveCalls += 1;
        return { kind: 'snapshot', snapshot: healthyChannel, cacheHit: false };
      },
    });
    expect(result.kind).toBe('skipped');
    expect(resolveCalls).toBe(0);
    // Ücretsiz kapıda elendiği için arayüzde bekleyen kart hiç gösterilmedi.
    expect(result.kind === 'skipped' && result.candidate).toBeNull();
  });

  it('negatif önbellek isabetinde aday geri çekilir', async () => {
    const result = await runPipeline(makeCard({ viewsApprox: 50_000, publishedAgeDays: 5 }), {
      config,
      isSeen: never,
      resolveCountry: async () => null,
      resolveChannel: resolver({ kind: 'rejected', reason: 'subs_out_of_range' }),
    });
    expect(result.kind === 'skipped' && result.reason).toBe('subs_out_of_range');
    // Ön filtreyi geçmişti: arayüzdeki bekleyen kartın kaldırılması gerekir.
    expect(result.kind === 'skipped' && result.candidate).not.toBeNull();
  });

  it('kanal bütçesi bitince eleme sebebi kalitesizlik değil bütçedir', async () => {
    const result = await runPipeline(makeCard({ viewsApprox: 50_000, publishedAgeDays: 5 }), {
      config,
      isSeen: never,
      resolveCountry: async () => null,
      resolveChannel: resolver({ kind: 'budget_exhausted' }),
    });
    expect(result.kind === 'skipped' && result.reason).toBe('channel_budget_exhausted');
    expect(result.kind === 'skipped' && result.stage).toBe('channel_fetch');
  });

  it('abone aralığı dışındaki kanal skorlanmadan elenir', async () => {
    const huge = makeSnapshot({
      subsApprox: 3_000_000,
      recentUploads: healthyChannel.recentUploads,
    });
    const result = await runPipeline(makeCard({ viewsApprox: 50_000, publishedAgeDays: 5 }), {
      config,
      isSeen: never,
      resolveCountry: async () => null,
      resolveChannel: resolver({ kind: 'snapshot', snapshot: huge, cacheHit: false }),
    });
    expect(result.kind === 'skipped' && result.reason).toBe('subs_out_of_range');
  });

  it('veri yetersizse skor uydurulmaz', async () => {
    const blank = makeSnapshot({ subsApprox: null, subsHidden: true, recentUploads: [] });
    const result = await runPipeline(makeCard({ viewsApprox: 50_000, publishedAgeDays: 5 }), {
      config,
      isSeen: never,
      resolveCountry: async () => null,
      resolveChannel: resolver({ kind: 'snapshot', snapshot: blank, cacheHit: false }),
    });
    expect(result.kind === 'skipped' && result.reason).toBe('insufficient_data');
  });
});

describe('izlenme tavanı — kanal isteği koruması', () => {
  it('dev kanal videosu kanal isteği harcamadan elenir', () => {
    // Canlı testte bulundu: öneri grafı sürekli 17M aboneli kanalları öneriyor
    // ve her biri pahalı bir kanal isteği yiyordu. İzlenme sayısı bedava vekil.
    const result = freeGate(makeCard({ viewsApprox: 5_000_000, publishedAgeDays: 5 }));
    expect(result.kind === 'skip' && result.reason).toBe('views_too_high');
    expect(result.kind === 'skip' && result.stage).toBe('prefilter');
  });

  it('gerçekçi bir outlier tavanın altında kalır', () => {
    // 50k aboneli kanalın 10 katlık hiti ~200 bin izlenme; tavan onu kesmez.
    expect(freeGate(makeCard({ viewsApprox: 200_000, publishedAgeDays: 5 })).kind).toBe('pass');
  });
});

describe('kapatılabilir sınırlar', () => {
  const off = (overrides: Partial<typeof config>) => ({ ...config, ...overrides });

  it('kapalı izlenme tavanı dev videoyu elemez', () => {
    const card = makeCard({ viewsApprox: 50_000_000, publishedAgeDays: 5 });
    expect(evaluateFreeGates(card, config, never).kind).toBe('skip');
    expect(evaluateFreeGates(card, off({ maxViews: null }), never).kind).toBe('pass');
  });

  it('kapalı izlenme tabanı küçük videoyu geçirir', () => {
    const card = makeCard({ viewsApprox: 300, publishedAgeDays: 5 });
    expect(evaluateFreeGates(card, off({ maxViews: null }), never).kind).toBe('skip');
    expect(evaluateFreeGates(card, off({ minViews: null, minVpd: null }), never).kind).toBe('pass');
  });

  it('kapalı yaş penceresi eski videoyu geçirir', () => {
    const card = makeCard({ viewsApprox: 50_000, publishedAgeDays: 900 });
    expect(evaluateFreeGates(card, config, never).kind).toBe('skip');
    expect(evaluateFreeGates(card, off({ maxVideoAgeDays: null, minVpd: null }), never).kind).toBe(
      'pass',
    );
  });

  it('abone sınırlarının ikisi de kapalıysa hiçbir kanal aralık dışı değildir', () => {
    const tiny = makeSnapshot({ subsApprox: 12 });
    const huge = makeSnapshot({ subsApprox: 90_000_000 });
    const unlimited = off({ minSubs: null, maxSubs: null });

    expect(gateSubscriberRange(tiny, config)).not.toBeNull();
    expect(gateSubscriberRange(huge, config)).not.toBeNull();
    expect(gateSubscriberRange(tiny, unlimited)).toBeNull();
    expect(gateSubscriberRange(huge, unlimited)).toBeNull();
  });

  it('yalnızca üst sınır açıkken alt sınır uygulanmaz', () => {
    const onlyMax = off({ minSubs: null, maxSubs: 50_000 });
    expect(gateSubscriberRange(makeSnapshot({ subsApprox: 12 }), onlyMax)).toBeNull();
    expect(gateSubscriberRange(makeSnapshot({ subsApprox: 900_000 }), onlyMax)).not.toBeNull();
  });

  it('yalnızca alt sınır açıkken üst sınır uygulanmaz', () => {
    const onlyMin = off({ minSubs: 1000, maxSubs: null });
    expect(gateSubscriberRange(makeSnapshot({ subsApprox: 90_000_000 }), onlyMin)).toBeNull();
    expect(gateSubscriberRange(makeSnapshot({ subsApprox: 12 }), onlyMin)).not.toBeNull();
  });
});

describe('ülke filtresi', () => {
  const withCountry = (countries: string[] | null, allowUnknown = false) => ({
    ...config,
    countries,
    allowUnknownCountry: allowUnknown,
  });
  const healthy = makeSnapshot({
    subsApprox: 12_000,
    recentUploads: makeUploads([2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000], OLD),
  });
  const card = () => makeCard({ viewsApprox: 50_000, publishedAgeDays: 5 });
  const ctx = (countries: string[] | null, country: string | null, allowUnknown = false) => ({
    config: withCountry(countries, allowUnknown),
    isSeen: never,
    resolveChannel: async (): Promise<ChannelResolution> => ({
      kind: 'snapshot' as const,
      snapshot: healthy,
      cacheHit: false,
    }),
    resolveCountry: async () => country,
  });

  it('filtre kapalıyken ülke hiç sorulmaz', async () => {
    let sorulduMu = false;
    const result = await runPipeline(card(), {
      ...ctx(null, 'Türkiye'),
      resolveCountry: async () => {
        sorulduMu = true;
        return 'Türkiye';
      },
    });
    expect(result.kind).toBe('matched');
    // Ek istek yalnızca filtre açıkken harcanır.
    expect(sorulduMu).toBe(false);
  });

  it('eşleşen ülke geçer', async () => {
    const result = await runPipeline(card(), ctx(['Türkiye'], 'Türkiye'));
    expect(result.kind).toBe('matched');
  });

  it('yerelleştirilmiş ad ile İngilizce ad aynı ülkedir', async () => {
    // YouTube "Türkiye" döndürüyor, kullanıcı "Turkey" yazmış olabilir.
    expect((await runPipeline(card(), ctx(['Turkey'], 'Türkiye'))).kind).toBe('matched');
    expect((await runPipeline(card(), ctx(['Almanya'], 'Germany'))).kind).toBe('matched');
  });

  it('farklı ülke elenir', async () => {
    const result = await runPipeline(card(), ctx(['Türkiye'], 'Germany'));
    expect(result.kind === 'skipped' && result.reason).toBe('country_mismatch');
  });

  it('ülkesi bilinmeyen kanal ayrı sebeple elenir', async () => {
    const result = await runPipeline(card(), ctx(['Türkiye'], null));
    expect(result.kind === 'skipped' && result.reason).toBe('country_unknown');
  });

  it('istenirse bilinmeyen ülke kabul edilir', async () => {
    const result = await runPipeline(card(), ctx(['Türkiye'], null, true));
    expect(result.kind).toBe('matched');
  });
});
