import type { ChannelSnapshot } from '@hype/shared';
import { type CrawlConfig, DEFAULT_CRAWL_CONFIG, type DomainEvent, type Match } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { TypedEventBus } from '../events/bus.js';
import { seededRng } from '../ports/rng.js';
import { makeCard, makeSnapshot, makeUploads } from '../testing/factories.js';
import {
  FakeClock,
  type FakeScenario,
  FakeYouTubeGateway,
  MemoryChannelCache,
  MemorySeenRepo,
} from '../testing/fakes.js';
import { CrawlerEngine, type EngineDeps } from './engine.js';

const SMALL = 'UC_small';
const BIG = 'UC_big';
const OLD = { startAgeDays: 35, ageStepDays: 7 };

/** Kanalın normali 10 bin izlenme; ekilen hit 3 günde 20 bin alıyor (~7 kat). */
const smallChannel = makeSnapshot({
  channelId: SMALL,
  subsApprox: 12_000,
  recentUploads: makeUploads([10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000], OLD),
});

const bigChannel = makeSnapshot({
  channelId: BIG,
  subsApprox: 5_000_000,
  recentUploads: makeUploads([400_000, 400_000, 400_000, 400_000, 400_000, 400_000], OLD),
});

function baseScenario(overrides: Partial<FakeScenario> = {}): FakeScenario {
  const homeFeed = Array.from({ length: 5 }, (_, i) =>
    makeCard({
      videoId: i === 0 ? 'seed1' : `seed${i + 1}`,
      channelId: BIG,
      viewsApprox: 500_000,
      publishedAgeDays: 5,
    }),
  );

  return {
    homeFeed,
    edges: {
      seed1: [
        makeCard({
          videoId: 'vid_hit',
          channelId: SMALL,
          viewsApprox: 20_000,
          publishedAgeDays: 3,
        }),
        makeCard({
          videoId: 'vid_hit2',
          channelId: SMALL,
          viewsApprox: 25_000,
          publishedAgeDays: 3,
        }),
        makeCard({
          videoId: 'vid_ordinary',
          channelId: SMALL,
          viewsApprox: 3000,
          publishedAgeDays: 8,
        }),
        makeCard({ videoId: 'vid_short', channelId: SMALL, kind: 'short', durationSec: 45 }),
      ],
    },
    channels: { [SMALL]: smallChannel, [BIG]: bigChannel },
    // Yaprak düğüm bırakmıyoruz: gerçek YouTube'da öneri rafı asla boş değildir.
    filler: { count: 4, channelId: SMALL, views: 3000, ageDays: 10 },
    ...overrides,
  };
}

interface Harness {
  engine: CrawlerEngine;
  gateway: FakeYouTubeGateway;
  clock: FakeClock;
  bus: TypedEventBus;
  seen: MemorySeenRepo;
  channels: MemoryChannelCache;
  events: DomainEvent[];
}

function harness(scenario: FakeScenario, seen = new MemorySeenRepo()): Harness {
  return harnessWith(scenario, seen, new MemoryChannelCache());
}

/** Kanal önbelleğini taramalar arasında PAYLAŞAN kurulum. */
function harnessWith(
  scenario: FakeScenario,
  seen: MemorySeenRepo,
  channels: MemoryChannelCache,
): Harness {
  const clock = new FakeClock();
  const bus = new TypedEventBus(clock);
  const gateway = new FakeYouTubeGateway(scenario);
  const events: DomainEvent[] = [];
  bus.subscribe((envelope) => events.push(envelope.event));

  const deps: EngineDeps = {
    gateway,
    channels,
    seen,
    clock,
    sleeper: clock,
    rng: seededRng(1234),
    bus,
  };
  return { engine: new CrawlerEngine(deps), gateway, clock, bus, seen, channels, events };
}

function config(overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return { ...DEFAULT_CRAWL_CONFIG, maxVideosScanned: 50, maxDepth: 3, ...overrides };
}

function matchesOf(events: readonly DomainEvent[]): Match[] {
  return events.flatMap((e) => (e.type === 'video_matched' ? [e.match] : []));
}

function cooldownsOf(events: readonly DomainEvent[]) {
  return events.flatMap((e) => (e.type === 'cooldown_started' ? [e] : []));
}

function skipsOf(events: readonly DomainEvent[]) {
  return events.flatMap((e) => (e.type === 'video_skipped' ? [e] : []));
}

describe('CrawlerEngine — tam tarama', () => {
  it('ekilen outlier yakalanır ve doğru skorlanır', async () => {
    const h = harness(baseScenario());
    const reason = await h.engine.start('run1', config());

    expect(reason).toBe('max_videos');
    const matches = matchesOf(h.events);
    const hit = matches.find((m) => m.videoId === 'vid_hit');
    expect(hit).toBeDefined();
    expect(hit?.scoreType).toBe('hype');
    expect(hit?.hype ?? 0).toBeGreaterThan(5);
    expect(hit?.channelId).toBe(SMALL);
    expect(hit?.seedVideoId).toBe('seed1');
    expect(hit?.lowConfidence).toBe(false);
  });

  it('Shorts ve sıradan videolar havuza girmez', async () => {
    const h = harness(baseScenario());
    await h.engine.start('run1', config());

    const matchedIds = matchesOf(h.events).map((m) => m.videoId);
    expect(matchedIds).not.toContain('vid_short');
    expect(matchedIds).not.toContain('vid_ordinary');

    const reasons = skipsOf(h.events).map((s) => s.reason);
    expect(reasons).toContain('shorts');
    expect(reasons).toContain('views_too_low');
  });

  it('kanal isteği yalnızca ön filtreyi geçen adaylar için harcanır ve önbelleğe alınır', async () => {
    const h = harness(baseScenario());
    await h.engine.start('run1', config());

    // Onlarca video tarandı ama yalnızca tek bir kanal isteği yapıldı:
    // ikinci aday önbellekten karşılandı, sıradan videolar hiç kanal sormadı.
    expect(h.gateway.channelCalls).toBe(1);
    expect(matchesOf(h.events).length).toBeGreaterThanOrEqual(2);

    const resolutions = h.events.flatMap((e) => (e.type === 'channel_resolved' ? [e] : []));
    expect(resolutions.some((r) => r.cacheHit)).toBe(true);
  });

  it('derinlik sınırı genişletmeyi durdurur', async () => {
    const h = harness(baseScenario());
    await h.engine.start('run1', config({ maxDepth: 2 }));

    const expansions = h.events.flatMap((e) => (e.type === 'node_expanded' ? [e.depth] : []));
    expect(expansions.length).toBeGreaterThan(3);
    expect(Math.max(...expansions)).toBeLessThanOrEqual(2);
  });

  it('istek bütçesi bitince sebep doğru ayrışır', async () => {
    const h = harness(baseScenario());
    const reason = await h.engine.start(
      'run1',
      config({ requestBudget: 100, maxVideosScanned: 20_000 }),
    );
    expect(reason).toBe('budget_exhausted');
  });

  it('havuzdaki video ikinci taramada tekrar yakalanmaz ama graf gezilebilir kalır', async () => {
    const seen = new MemorySeenRepo();

    const first = harness(baseScenario(), seen);
    await first.engine.start('run1', config());
    expect(matchesOf(first.events).map((m) => m.videoId)).toContain('vid_hit');

    const second = harness(baseScenario(), seen);
    await second.engine.start('run2', config());

    expect(matchesOf(second.events).map((m) => m.videoId)).not.toContain('vid_hit');
    // Yine de düğüm olarak görüldü: üstünden yürümeye devam edebiliyoruz.
    const seenSkips = skipsOf(second.events).filter((s) => s.reason === 'seen');
    expect(seenSkips.map((s) => s.videoId)).toContain('vid_hit');
    expect(second.gateway.watchNextCalls).toBeGreaterThan(3);
  });
});

describe('CrawlerEngine — kısıtlama ve toparlanma', () => {
  it('üst üste boş öneri rafı molaya çevrilir, sonra tarama devam eder', async () => {
    const h = harness(baseScenario({ emptyWatchNextCount: 3 }));
    const reason = await h.engine.start('run1', config());

    const cooldowns = cooldownsOf(h.events);
    expect(cooldowns).toHaveLength(1);
    expect(cooldowns[0]?.cause).toBe('empty_feeds');
    // Mola sonrası tarama kaldığı yerden sürdü.
    expect(h.gateway.watchNextCalls).toBeGreaterThan(3);
    expect(reason).toBe('max_videos');
  });

  it('bot duvarı tek sinyalde 45 dakikalık mola verdirir', async () => {
    const start = new FakeClock().now();
    // 1. istek ana sayfa, 2. istek ilk watch-next.
    const h = harness(baseScenario({ errors: { 2: 'login_required' } }));
    await h.engine.start('run1', config());

    const cooldowns = cooldownsOf(h.events);
    expect(cooldowns[0]?.cause).toBe('login_required');
    expect((cooldowns[0]?.until ?? 0) - start).toBe(45 * 60_000);
  });

  it('mola sırasında saat gerçekten ilerler ve durum crawling’e döner', async () => {
    const h = harness(baseScenario({ errors: { 2: 'login_required' } }));
    const before = h.clock.now();
    await h.engine.start('run1', config());
    expect(h.clock.now() - before).toBeGreaterThanOrEqual(45 * 60_000);
    expect(h.engine.phase).toBe('stopped');
  });

  it('gateway hatası tüm taramayı öldürmez', async () => {
    const h = harness(baseScenario({ errors: { 3: 'network', 5: 'not_found' } }));
    const reason = await h.engine.start('run1', config());
    expect(reason).toBe('max_videos');
    expect(h.events.some((e) => e.type === 'engine_error')).toBe(false);
  });
});

describe('CrawlerEngine — yaşam döngüsü', () => {
  it('duraklatma ve sürdürme taramayı bozmaz', async () => {
    const h = harness(baseScenario());
    let paused = false;
    h.bus.subscribe((envelope) => {
      if (envelope.event.type === 'video_matched' && !paused) {
        paused = true;
        h.engine.pause();
        setTimeout(() => h.engine.resume(), 0);
      }
    });

    const reason = await h.engine.start('run1', config());
    const phases = h.events.flatMap((e) => (e.type === 'state_changed' ? [e.to] : []));
    expect(phases).toContain('paused');
    expect(reason).toBe('max_videos');
  });

  it('durdurma isteği taramayı manuel sebeple bitirir', async () => {
    const h = harness(baseScenario());
    h.bus.subscribe((envelope) => {
      if (envelope.event.type === 'node_expanded') h.engine.stop();
    });
    const reason = await h.engine.start('run1', config());
    expect(reason).toBe('manual');
    expect(h.engine.phase).toBe('stopped');
  });

  it('anlık görüntü geri yüklendiğinde harcanan bütçe korunur', async () => {
    const h = harness(baseScenario());
    await h.engine.start('run1', config());

    const snapshot = h.engine.snapshot();
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.budgets.videosScanned).toBeGreaterThan(0);

    const revived = harness(baseScenario());
    revived.engine.restore(snapshot);
    const restored = revived.engine.snapshot();
    expect(restored?.budgets).toEqual(snapshot.budgets);
    expect(restored?.frontier.length).toBe(snapshot.frontier.length);
    expect(restored?.currentSeedId).toBe(snapshot.currentSeedId);
  });

  it('çalışan tarama ikinci kez başlatılamaz', async () => {
    const h = harness(baseScenario());
    const running = h.engine.start('run1', config());
    await expect(h.engine.start('run2', config())).rejects.toThrow(/zaten çalışıyor/);
    await running;
  });

  it('bitmiş motor yeniden başlatılabilir', async () => {
    const h = harness(baseScenario());
    await h.engine.start('run1', config());
    const second = await h.engine.start('run2', config());
    expect(second).toBe('max_videos');
  });

  it('istatistikler huninin her adımını sayar', async () => {
    const h = harness(baseScenario());
    await h.engine.start('run1', config());

    const finished = h.events.flatMap((e) => (e.type === 'run_finished' ? [e.stats] : []));
    const stats = finished[0];
    expect(stats).toBeDefined();
    if (stats === undefined) return;
    expect(stats.scanned).toBeGreaterThanOrEqual(50);
    expect(stats.matched).toBeGreaterThanOrEqual(2);
    expect(stats.expanded).toBeGreaterThan(0);
    expect(stats.channelFetches).toBe(1);
    expect(stats.rejects.views_too_low ?? 0).toBeGreaterThan(0);
    expect(stats.requestsTotal).toBe(stats.requestsClassA + stats.requestsClassB);
  });
});

describe('CrawlerEngine — sınır kapatıldığında önbellek', () => {
  it('eski "aralık dışı" verdikti gevşetilmiş ayarı engellemez', async () => {
    // Dar aralıkla tarayıp dev kanalı negatif önbelleğe yazdır.
    const seen = new MemorySeenRepo();
    const narrow = harness(baseScenario(), seen);
    await narrow.engine.start('run1', config());
    const cached = await narrow.channels.get(BIG);
    expect(cached?.verdict).not.toBe('in_range');

    // Aynı önbellekle, abone sınırları KAPALI ikinci tarama.
    const clock = new FakeClock();
    const bus = new TypedEventBus(clock);
    const gateway = new FakeYouTubeGateway(baseScenario());
    const events: DomainEvent[] = [];
    bus.subscribe((e) => events.push(e.event));
    const engine = new CrawlerEngine({
      gateway,
      channels: narrow.channels,
      seen: new MemorySeenRepo(),
      clock,
      sleeper: clock,
      rng: seededRng(7),
      bus,
    });

    await engine.start('run2', config({ minSubs: null, maxSubs: null }));

    // Kapatılan filtre gerçekten etkili: dev kanal artık negatif önbellekten
    // reddedilmiyor, videoları değerlendiriliyor.
    const negativeSkips = skipsOf(events).filter((s) => s.reason === 'subs_out_of_range');
    expect(negativeSkips).toHaveLength(0);
  });
});

describe('CrawlerEngine — kanal modu', () => {
  const RISING = 'UC_rising';
  const DAY = 86_400_000;
  /** FakeClock sabit bir andan başlıyor; yaşlar deterministik yazılabiliyor. */
  const NOW = 1_754_500_000_000;

  /** Videolarının çoğu abonesini aşan, yükselen bir kanal. */
  const risingChannel: ChannelSnapshot = {
    channelId: RISING,
    name: 'Yükselen Kanal',
    handle: '@rising',
    subsApprox: 5000,
    subsText: '5K subscribers',
    subsHidden: false,
    country: null,
    recentUploads: [
      makeCard({ videoId: 'r_top', channelId: RISING, viewsApprox: 90_000, publishedAgeDays: 6 }),
      makeCard({ videoId: 'r_2', channelId: RISING, viewsApprox: 70_000, publishedAgeDays: 12 }),
      makeCard({ videoId: 'r_3', channelId: RISING, viewsApprox: 60_000, publishedAgeDays: 18 }),
      makeCard({ videoId: 'r_4', channelId: RISING, viewsApprox: 50_000, publishedAgeDays: 24 }),
      makeCard({ videoId: 'r_5', channelId: RISING, viewsApprox: 40_000, publishedAgeDays: 30 }),
      makeCard({ videoId: 'r_low', channelId: RISING, viewsApprox: 800, publishedAgeDays: 36 }),
    ],
    fetchedAt: NOW,
  };

  function channelScenario(
    joinedAtMs: number | null = NOW - 120 * DAY,
    overrides: Partial<FakeScenario> = {},
  ): FakeScenario {
    return {
      homeFeed: [makeCard({ videoId: 'seed1', channelId: BIG, viewsApprox: 500_000 })],
      edges: {
        seed1: [
          makeCard({
            videoId: 'walk_1',
            channelId: RISING,
            viewsApprox: 90_000,
            publishedAgeDays: 6,
          }),
        ],
      },
      channels: { [RISING]: risingChannel, [BIG]: bigChannel },
      abouts: { [RISING]: { country: 'Germany', joinedAtMs } },
      filler: { count: 2, channelId: SMALL, views: 3000, ageDays: 10 },
      ...overrides,
    };
  }

  const channelConfig = (overrides: Partial<CrawlConfig> = {}) =>
    config({
      mode: 'channel',
      maxVideosScanned: 30,
      minSubs: 1000,
      maxSubs: 250_000,
      minChannelUploads: 4,
      minChannelMedianViews: 10_000,
      maxChannelAgeDays: 180,
      ...overrides,
    });

  it('yükselen kanalı yakalar ve TEMSİLCİ videoyla kaydeder', async () => {
    const { engine, events } = harness(channelScenario());
    await engine.start('run1', channelConfig());

    const matches = matchesOf(events);
    expect(matches).toHaveLength(1);
    const match = matches[0];
    expect(match?.scoreType).toBe('channel');
    // En çok izlenen video kanalı temsil eder — yürünen kart değil.
    expect(match?.videoId).toBe('r_top');
    expect(match?.channelId).toBe(RISING);
    expect(match?.channelHitRate).toBeCloseTo(5 / 6, 5);
    expect(match?.channelAgeDays).toBeCloseTo(120, 0);
    // Çarpan `vsr` kolonunda taşınıyor (DB CHECK kısıtı) — `hype` boş.
    expect(match?.hype).toBeNull();
    expect(match?.vsr).toBeGreaterThan(0);
  });

  it('aynı kanal bir taramada BİR KEZ yakalanır', async () => {
    /*
     * Öneri grafı aynı kanalın videolarını ısrarla gösteriyor. Kullanıcının
     * istediği kanal başına tek kart; ayrıca her kart için kanalı yeniden
     * çözmek boşa istek olurdu.
     */
    const scenario = channelScenario();
    scenario.edges = {
      seed1: Array.from({ length: 5 }, (_, i) =>
        makeCard({
          videoId: `walk_${i}`,
          channelId: RISING,
          viewsApprox: 90_000 - i * 1000,
          publishedAgeDays: 6,
        }),
      ),
    };
    const { engine, gateway, events } = harness(scenario);
    await engine.start('run1', channelConfig());

    expect(matchesOf(events)).toHaveLength(1);
    expect(gateway.channelCalls).toBe(1);
    expect(gateway.aboutCalls).toBe(1);
  });

  it('KURULUŞ TARİHİ yaşlıysa elenir — yüklemelerin gençliği aldatmaz', async () => {
    /*
     * En kritik zehir vakası. Kanalın son 30 videosu tamamen taze olabilir ama
     * bu kanalın YENİ olduğu anlamına gelmez: Videos sekmesinin yalnızca ilk
     * sayfasını görüyoruz, yani sık yükleyen ESKİ bir kanal da böyle görünür.
     * Karar bu yüzden `joined_date`'ten geliyor, yüklemelerden değil.
     */
    const { engine, events } = harness(channelScenario(NOW - 730 * DAY));
    await engine.start('run1', channelConfig());

    expect(matchesOf(events)).toHaveLength(0);
    expect(skipsOf(events).map((s) => s.reason)).toContain('channel_too_old');
  });

  it('MEDYAN izlenme eşiğin altındaysa elenir — tek patlayan video kurtarmaz', async () => {
    /*
     * Tek videosu 90B, kalan beşi 500. Maksimuma baksaydık bu kanal geçerdi;
     * medyan (500) geçirmiyor. Kapının medyanda durmasının bütün sebebi bu.
     */
    const zayif: ChannelSnapshot = {
      ...risingChannel,
      recentUploads: risingChannel.recentUploads.map((u, i) =>
        i === 0 ? u : { ...u, viewsApprox: 500 },
      ),
    };
    const { engine, events } = harness(
      channelScenario(NOW - 60 * DAY, { channels: { [RISING]: zayif, [BIG]: bigChannel } }),
    );
    await engine.start('run1', channelConfig());

    expect(matchesOf(events)).toHaveLength(0);
    expect(skipsOf(events).map((s) => s.reason)).toContain('channel_views_low');
  });

  it('yükleme sayısı yetersiz kanal elenir', async () => {
    const yeni: ChannelSnapshot = {
      ...risingChannel,
      recentUploads: risingChannel.recentUploads.slice(0, 2),
    };
    const { engine, events } = harness(
      channelScenario(NOW - 20 * DAY, { channels: { [RISING]: yeni, [BIG]: bigChannel } }),
    );
    await engine.start('run1', channelConfig());

    expect(skipsOf(events).map((s) => s.reason)).toContain('channel_too_few_uploads');
  });

  it('kuruluş tarihi okunamayınca varsayılan davranış ELEMEK', async () => {
    const { engine, events } = harness(channelScenario(null));
    await engine.start('run1', channelConfig());

    expect(matchesOf(events)).toHaveLength(0);
    expect(skipsOf(events).map((s) => s.reason)).toContain('channel_age_unknown');
  });

  it('izin verilirse tarihsiz kanal yakalanır ama işaretlenir', async () => {
    const { engine, events } = harness(channelScenario(null));
    await engine.start('run1', channelConfig({ allowUnknownChannelAge: true }));

    const match = matchesOf(events)[0];
    expect(match).toBeDefined();
    expect(match?.channelAgeDays).toBeNull();
    expect(match?.lowConfidenceReasons).toContain('age_unknown');
  });

  it('yaş eşiği YAPIŞMAZ — gevşetilen ayar önbellekten yeniden değerlendirilir', async () => {
    /*
     * Yaşın asla `verdict`'e yazılmamasının sebebi bu. Verdikt kalıcı
     * saklanıyor; yaş oraya girseydi kullanıcı eşiği gevşettiğinde eski karar
     * yapışır ve filtre işe yaramaz olurdu.
     */
    const seen = new MemorySeenRepo();
    const channels = new MemoryChannelCache();
    const scenario = channelScenario(NOW - 300 * DAY);

    const dar = harnessWith(scenario, seen, channels);
    await dar.engine.start('run1', channelConfig({ maxChannelAgeDays: 180 }));
    expect(matchesOf(dar.events)).toHaveLength(0);

    // İkinci tarama gevşek eşikle: kanal önbellekte, ek istek gerekmemeli.
    const genis = harnessWith(scenario, new MemorySeenRepo(), channels);
    await genis.engine.start('run2', channelConfig({ maxChannelAgeDays: 365 }));

    expect(matchesOf(genis.events)).toHaveLength(1);
    expect(genis.gateway.aboutCalls).toBe(0);
  });

  it('temsilci daha önce yakalanmışsa sıradakine düşülür', async () => {
    const seen = new MemorySeenRepo();
    await seen.add('r_top');
    const { engine, events } = harness(channelScenario(), seen);
    await engine.start('run1', channelConfig());

    expect(matchesOf(events)[0]?.videoId).toBe('r_2');
  });

  it('video modu kanal alanlarını boş bırakır', async () => {
    const { engine, events } = harness(baseScenario());
    await engine.start('run1', config());

    const match = matchesOf(events)[0];
    expect(match?.scoreType).not.toBe('channel');
    expect(match?.channelHitRate).toBeNull();
    expect(match?.channelAgeDays).toBeNull();
  });
});

describe('CrawlerEngine — dil tabanlı yürüyüş', () => {
  /** Tohumun iki komşusu: biri Türkçe, biri İngilizce; ikisi de sıradan video. */
  function bilingualScenario(): FakeScenario {
    return {
      homeFeed: [makeCard({ videoId: 'seed1', channelId: BIG, viewsApprox: 500_000 })],
      edges: {
        seed1: [
          makeCard({
            videoId: 'vid_tr',
            title: 'Köy hayatı ve doğal yaşam belgeseli',
            channelId: SMALL,
            viewsApprox: 3000,
            publishedAgeDays: 8,
          }),
          makeCard({
            videoId: 'vid_en',
            title: 'How It Works: The Best Documentary',
            channelId: SMALL,
            viewsApprox: 3000,
            publishedAgeDays: 8,
          }),
        ],
      },
      channels: { [SMALL]: smallChannel, [BIG]: bigChannel },
      filler: { count: 2, channelId: SMALL, views: 3000, ageDays: 10 },
    };
  }

  const expandedIds = (events: readonly DomainEvent[]) =>
    events.flatMap((e) => (e.type === 'node_expanded' ? [e.videoId] : []));

  it('filtre kapalıyken her iki dilden de yürünür', async () => {
    const { engine, events } = harness(bilingualScenario());
    await engine.start('run1', config({ maxVideosScanned: 30 }));

    const expanded = expandedIds(events);
    expect(expanded).toContain('vid_tr');
    expect(expanded).toContain('vid_en');
  });

  it('filtre açıkken YALNIZCA hedef dildeki kenardan yürünür', async () => {
    /*
     * Asıl iddianın testi: dil tutmayan komşu yalnızca "elenmiş" olmuyor,
     * üstünden YÜRÜNMÜYOR. Pipeline'a konsaydı `explorable` sayılıp keşif
     * örneklemine girerdi ve graf yine İngilizceye kayardı.
     */
    const { engine, events } = harness(bilingualScenario());
    await engine.start('run1', config({ maxVideosScanned: 30, crawlLanguages: ['tr'] }));

    const expanded = expandedIds(events);
    expect(expanded).toContain('vid_tr');
    expect(expanded).not.toContain('vid_en');

    const skipped = skipsOf(events).filter((s) => s.reason === 'language_mismatch');
    expect(skipped.map((s) => s.videoId)).toContain('vid_en');
  });

  it('dil kapısı BEDAVA: eleme kanal isteği harcamaz', async () => {
    // Kapı pipeline'dan önce olduğu için elenen kart için kanal sorulmuyor.
    const withFilter = harness(bilingualScenario());
    await withFilter.engine.start('run1', config({ maxVideosScanned: 30, crawlLanguages: ['tr'] }));

    const without = harness(bilingualScenario());
    await without.engine.start('run1', config({ maxVideosScanned: 30 }));

    expect(withFilter.gateway.channelCalls).toBeLessThanOrEqual(without.gateway.channelCalls);
  });

  it('dili ayırt edilemeyen kart varsayılan olarak yürünebilir kalır', async () => {
    /*
     * Varsayılan `allowUnknownLanguage: true`. Aksi hâlde başlığı kısa ya da
     * sadece marka adından ibaret olan videolar grafı kesip taramayı boğardı —
     * "bilinmiyor"u "eşleşmedi" saymanın bedeli bu olurdu.
     */
    const scenario = bilingualScenario();
    scenario.edges = {
      seed1: [
        makeCard({
          videoId: 'vid_belirsiz',
          title: 'MrBeast 2026',
          channelId: SMALL,
          viewsApprox: 3000,
          publishedAgeDays: 8,
        }),
      ],
    };
    const { engine, events } = harness(scenario);
    await engine.start('run1', config({ maxVideosScanned: 30, crawlLanguages: ['tr'] }));

    expect(expandedIds(events)).toContain('vid_belirsiz');
  });
});

describe('CrawlerEngine — duraklama tepkiselliği', () => {
  it('duraklama bir düğüm genişletmesinin ortasında da devreye girer', async () => {
    const h = harness(baseScenario());
    let taranan = 0;
    let duraklatildi = false;

    h.bus.subscribe((envelope) => {
      if (envelope.event.type !== 'video_scanned') return;
      taranan += 1;
      // İlk kartta duraklat: motor sıradaki karta geçmeden fark etmeli.
      if (taranan === 1 && !duraklatildi) {
        duraklatildi = true;
        h.engine.pause();
        setTimeout(() => h.engine.resume(), 0);
      }
    });

    const reason = await h.engine.start('run1', config());
    const phases = h.events.flatMap((e) => (e.type === 'state_changed' ? [e.to] : []));
    expect(phases).toContain('paused');
    expect(reason).toBe('max_videos');
  });
});
