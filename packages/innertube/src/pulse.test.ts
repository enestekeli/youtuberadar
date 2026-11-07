import { describe, expect, it } from 'vitest';
import { DEFAULT_PULSE_BOUNDS, PULSE_CALM_WINDOW_MS, PulseController } from './pulse.js';

const MIN = 60_000;

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const full = { lastHourTotal: 1100, lastHourClassB: 350 };

describe('nabız — limitler YouTube’un tepkisine göre', () => {
  it('sakin ve tavan doluysa 10 dakikada bir büyür, bekleme kısalır', () => {
    const c = clock();
    const p = new PulseController(c.now);
    expect(p.tick(full)).toBeNull(); // pencere dolmadı
    c.advance(PULSE_CALM_WINDOW_MS);
    const up = p.tick(full);
    expect(up?.hourlyTotalCap).toBe(1200);
    expect(up?.hourlyClassBCap).toBe(380);
    expect(up?.intervalScale).toBeCloseTo(0.95, 3);
    expect(p.snapshot.mood).toBe('hızlanıyor');
  });

  it('tavan kullanılmıyorsa büyümez', () => {
    const c = clock();
    const p = new PulseController(c.now);
    c.advance(PULSE_CALM_WINDOW_MS);
    expect(p.tick({ lastHourTotal: 200, lastHourClassB: 50 })).toBeNull();
    expect(p.snapshot.limits.hourlyTotalCap).toBe(1100);
  });

  it('uyarıda %15, molada %40 küçülür; molada büyüme 30 dk donar', () => {
    const c = clock();
    const p = new PulseController(c.now);
    expect(p.onWarning('429').hourlyTotalCap).toBe(935);
    const m = p.onCooldown('http_429');
    expect(m.hourlyTotalCap).toBe(561);
    expect(m.intervalScale).toBeCloseTo(1.65, 2);
    expect(p.snapshot.mood).toBe('molada');

    c.advance(15 * MIN);
    expect(p.tick(full)).toBeNull(); // donmuş
    c.advance(16 * MIN);
    expect(p.tick(full)?.hourlyTotalCap).toBe(661); // donma bitti, sakin pencere de geçti
  });

  it('alt ve üst sınırların dışına çıkmaz', () => {
    const c = clock();
    const p = new PulseController(c.now);
    for (let i = 0; i < 20; i++) p.onCooldown('login_required');
    // Molada tavanlar alt sınıra iner, bekleme ise üst sınıra çıkar.
    expect(p.snapshot.limits).toEqual({
      hourlyTotalCap: DEFAULT_PULSE_BOUNDS.min.hourlyTotalCap,
      hourlyClassBCap: DEFAULT_PULSE_BOUNDS.min.hourlyClassBCap,
      intervalScale: DEFAULT_PULSE_BOUNDS.max.intervalScale,
    });

    const q = new PulseController(c.now, {
      // En hızlı uç: tavanlar üstte, bekleme altta.
      limits: {
        ...DEFAULT_PULSE_BOUNDS.max,
        intervalScale: DEFAULT_PULSE_BOUNDS.min.intervalScale,
      },
    });
    c.advance(PULSE_CALM_WINDOW_MS);
    expect(q.tick({ lastHourTotal: 2400, lastHourClassB: 700 })).toBeNull();
    expect(q.snapshot.reason).toBe('üst sınırda');
  });

  it('kayıtlı durumdan devam eder (yeniden başlatmada öğrenilen limit kaybolmaz)', () => {
    const c = clock(1000);
    const p = new PulseController(c.now);
    p.onCooldown('empty_feeds');
    const saved = JSON.parse(JSON.stringify(p.snapshot));
    const q = new PulseController(c.now, saved);
    expect(q.snapshot.limits).toEqual(p.snapshot.limits);
    expect(q.snapshot.frozenUntil).toBe(p.snapshot.frozenUntil);
  });
});
