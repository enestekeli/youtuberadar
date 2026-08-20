import { DEFAULT_CRAWL_CONFIG } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { TypedEventBus } from '../events/bus.js';
import {
  BOT_WALL_BASE_COOLDOWN_MS,
  EMPTY_FEED_BASE_COOLDOWN_MS,
  HTTP_429_BASE_COOLDOWN_MS,
  HTTP_429_WINDOW_MS,
  LEVEL_RESET_AFTER_SUCCESSES,
  MAX_COOLDOWN_MS,
  ThrottleDetector,
} from '../health/throttle-detector.js';
import { seededRng } from '../ports/rng.js';
import { FakeClock } from '../testing/fakes.js';
import { Budgets } from './budgets.js';
import { Frontier } from './frontier.js';
import { pickNext } from './policy.js';
import { canTransition } from './state.js';

describe('durum makinesi', () => {
  it('meşru geçişlere izin verir', () => {
    expect(canTransition('idle', 'seeding')).toBe(true);
    expect(canTransition('seeding', 'crawling')).toBe(true);
    expect(canTransition('crawling', 'cooldown')).toBe(true);
    expect(canTransition('cooldown', 'crawling')).toBe(true);
    expect(canTransition('paused', 'crawling')).toBe(true);
    expect(canTransition('stopping', 'stopped')).toBe(true);
    expect(canTransition('stopped', 'idle')).toBe(true);
  });

  it('gayrimeşru geçişleri reddeder', () => {
    expect(canTransition('idle', 'crawling')).toBe(false);
    expect(canTransition('stopped', 'crawling')).toBe(false);
    expect(canTransition('stopping', 'crawling')).toBe(false);
    expect(canTransition('idle', 'cooldown')).toBe(false);
  });
});

describe('frontier', () => {
  it('yinelenen video eklenmez', () => {
    const f = new Frontier(10);
    expect(f.add({ videoId: 'a', depth: 0, vpd: 10, parentVideoId: null })).toBe(true);
    expect(f.add({ videoId: 'a', depth: 1, vpd: 99, parentVideoId: null })).toBe(false);
    expect(f.size).toBe(1);
  });

  it('kapasite dolunca en düşük hızlı düğüm atılır', () => {
    const f = new Frontier(3);
    for (const [id, vpd] of [
      ['a', 10],
      ['b', 20],
      ['c', 5],
      ['d', 30],
    ] as const) {
      f.add({ videoId: id, depth: 0, vpd, parentVideoId: null });
    }
    expect(f.size).toBe(3);
    expect(f.has('c')).toBe(false);
    expect(f.has('d')).toBe(true);
  });

  it('hızı okunamayan düğümler önce atılır ama tamamen dışlanmaz', () => {
    const f = new Frontier(2);
    f.add({ videoId: 'bilinmiyor', depth: 0, vpd: null, parentVideoId: null });
    f.add({ videoId: 'a', depth: 0, vpd: 1, parentVideoId: null });
    expect(f.size).toBe(2);
    f.add({ videoId: 'b', depth: 0, vpd: 2, parentVideoId: null });
    expect(f.has('bilinmiyor')).toBe(false);
  });

  it('en hızlı düğüm seçilir', () => {
    const f = new Frontier(10);
    f.add({ videoId: 'yavas', depth: 0, vpd: 5, parentVideoId: null });
    f.add({ videoId: 'hizli', depth: 0, vpd: 5000, parentVideoId: null });
    expect(f.peekBest()?.videoId).toBe('hizli');
  });

  it('anlık görüntü alınıp geri yüklenebilir', () => {
    const f = new Frontier(10);
    f.add({ videoId: 'a', depth: 2, vpd: 10, parentVideoId: 'p' });
    f.add({ videoId: 'b', depth: 3, vpd: 20, parentVideoId: 'p' });

    const restored = new Frontier(10);
    restored.restore(f.snapshot());
    expect(restored.size).toBe(2);
    expect(restored.has('a')).toBe(true);
    expect(restored.peekBest()?.videoId).toBe('b');
    // Sıra numarası korunur: geri yüklenen kuyruğa ekleme çakışma yaratmaz.
    expect(restored.add({ videoId: 'c', depth: 1, vpd: 1, parentVideoId: null })).toBe(true);
  });
});

describe('keşif politikası', () => {
  const build = () => {
    const f = new Frontier(10);
    f.add({ videoId: 'a', depth: 0, vpd: 1, parentVideoId: null });
    f.add({ videoId: 'b', depth: 0, vpd: 2, parentVideoId: null });
    f.add({ videoId: 'c', depth: 0, vpd: 3000, parentVideoId: null });
    return f;
  };

  it('epsilon 0 ise her zaman en hızlı düğüm', () => {
    const f = build();
    const rng = seededRng(1);
    for (let i = 0; i < 20; i++) expect(pickNext(f, 0, rng)?.videoId).toBe('c');
  });

  it('epsilon 1 ise seçim çeşitlenir (yankı fanusu kırılır)', () => {
    const f = build();
    const rng = seededRng(42);
    const picked = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const next = pickNext(f, 1, rng);
      if (next !== null) picked.add(next.videoId);
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  it('aynı tohumla aynı sonuç (deterministik test edilebilirlik)', () => {
    const runOnce = () => {
      const f = build();
      const rng = seededRng(7);
      return Array.from({ length: 10 }, () => pickNext(f, 0.5, rng)?.videoId ?? '');
    };
    expect(runOnce()).toEqual(runOnce());
  });

  it('boş kuyrukta null', () => {
    expect(pickNext(new Frontier(10), 0.2, seededRng(1))).toBeNull();
  });
});

describe('bütçeler', () => {
  it('kanal isteği iki ucuz isteğe mal olur', () => {
    const b = new Budgets(DEFAULT_CRAWL_CONFIG);
    b.recordChannelFetch();
    expect(b.snapshot.channelFetches).toBe(1);
    expect(b.snapshot.requestsClassA).toBe(2);
  });

  it('kanal bütçesi bitince yeni kanal çözülmez', () => {
    const b = new Budgets({ ...DEFAULT_CRAWL_CONFIG, channelRequestBudget: 2 });
    expect(b.hasChannelBudget()).toBe(true);
    b.recordChannelFetch();
    b.recordChannelFetch();
    expect(b.hasChannelBudget()).toBe(false);
  });

  it('durma sebebi doğru ayrışır', () => {
    const scanned = new Budgets({ ...DEFAULT_CRAWL_CONFIG, maxVideosScanned: 50 });
    scanned.recordScan(50);
    expect(scanned.exhausted()).toBe('max_videos');

    const spent = new Budgets({ ...DEFAULT_CRAWL_CONFIG, requestBudget: 100 });
    spent.recordClassB(100);
    expect(spent.exhausted()).toBe('budget_exhausted');
  });

  it('geri yükleme harcamayı korur — yeniden başlatma bütçe sıfırlamaz', () => {
    const b = new Budgets(DEFAULT_CRAWL_CONFIG);
    b.recordScan(10);
    b.recordChannelFetch();
    const restored = new Budgets(DEFAULT_CRAWL_CONFIG);
    restored.restore(b.snapshot);
    expect(restored.snapshot).toEqual(b.snapshot);
  });
});

describe('kısıtlama sezgisi', () => {
  it('bot duvarı tek sinyalde uzun mola verdirir', () => {
    const detector = new ThrottleDetector(new FakeClock());
    const trip = detector.recordError('login_required');
    expect(trip?.cause).toBe('login_required');
    expect(trip?.cooldownMs).toBe(BOT_WALL_BASE_COOLDOWN_MS);
  });

  it('tek 429 mola gerektirmez, penceredeki ikincisi gerektirir', () => {
    const clock = new FakeClock();
    const detector = new ThrottleDetector(clock);
    expect(detector.recordError('throttled_soft')).toBeNull();
    const trip = detector.recordError('throttled_soft');
    expect(trip?.cause).toBe('http_429');
    expect(trip?.cooldownMs).toBe(HTTP_429_BASE_COOLDOWN_MS);
  });

  it('pencere dışındaki iki 429 rastlantı sayılır', () => {
    const clock = new FakeClock();
    const detector = new ThrottleDetector(clock);
    expect(detector.recordError('throttled_soft')).toBeNull();
    clock.advance(HTTP_429_WINDOW_MS + 1);
    expect(detector.recordError('throttled_soft')).toBeNull();
  });

  it('üst üste boş feed sessiz kısıtlama sayılır', () => {
    const detector = new ThrottleDetector(new FakeClock());
    expect(detector.recordEmptyFeed()).toBeNull();
    expect(detector.recordEmptyFeed()).toBeNull();
    const trip = detector.recordEmptyFeed();
    expect(trip?.cause).toBe('empty_feeds');
    expect(trip?.cooldownMs).toBe(EMPTY_FEED_BASE_COOLDOWN_MS);
  });

  it('araya giren başarı boş feed sayacını sıfırlar', () => {
    const detector = new ThrottleDetector(new FakeClock());
    detector.recordEmptyFeed();
    detector.recordEmptyFeed();
    detector.recordSuccess();
    expect(detector.recordEmptyFeed()).toBeNull();
  });

  it('tekrarlayan mola süresi ikiye katlanır ve tavanla sınırlanır', () => {
    const detector = new ThrottleDetector(new FakeClock());
    const first = detector.recordError('login_required');
    const second = detector.recordError('login_required');
    expect(second?.cooldownMs).toBe((first?.cooldownMs ?? 0) * 2);

    for (let i = 0; i < 10; i++) detector.recordError('login_required');
    const last = detector.recordError('login_required');
    expect(last?.cooldownMs).toBe(MAX_COOLDOWN_MS);
  });

  it('yeterince başarıdan sonra ceza seviyesi sıfırlanır', () => {
    const detector = new ThrottleDetector(new FakeClock());
    detector.recordError('login_required');
    for (let i = 0; i < LEVEL_RESET_AFTER_SUCCESSES; i++) detector.recordSuccess();
    const trip = detector.recordError('login_required');
    expect(trip?.cooldownMs).toBe(BOT_WALL_BASE_COOLDOWN_MS);
  });

  it('ağ hatası ve bulunamayan video kimliğin sorunu değildir', () => {
    const detector = new ThrottleDetector(new FakeClock());
    expect(detector.recordError('network')).toBeNull();
    expect(detector.recordError('not_found')).toBeNull();
  });
});

describe('olay veriyolu', () => {
  it('sıra numarası monoton artar', () => {
    const bus = new TypedEventBus(new FakeClock());
    const first = bus.emit('r1', { type: 'depth_changed', depth: 1, maxDepth: 4 });
    const second = bus.emit('r1', { type: 'depth_changed', depth: 2, maxDepth: 4 });
    expect(second.seq).toBe(first.seq + 1);
  });

  it('patlayan abone motoru ya da diğer aboneleri etkilemez', () => {
    const errors: unknown[] = [];
    const bus = new TypedEventBus(new FakeClock(), (e) => errors.push(e));
    const received: number[] = [];
    bus.subscribe(() => {
      throw new Error('abone patladı');
    });
    bus.subscribe((env) => received.push(env.seq));

    expect(() => bus.emit(null, { type: 'depth_changed', depth: 1, maxDepth: 4 })).not.toThrow();
    expect(received).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('abonelik iptal edilebilir', () => {
    const bus = new TypedEventBus(new FakeClock());
    let count = 0;
    const off = bus.subscribe(() => {
      count += 1;
    });
    bus.emit(null, { type: 'depth_changed', depth: 1, maxDepth: 4 });
    off();
    bus.emit(null, { type: 'depth_changed', depth: 2, maxDepth: 4 });
    expect(count).toBe(1);
  });
});
