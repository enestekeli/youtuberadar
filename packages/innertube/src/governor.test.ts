import { seededRng } from '@hype/core';
import { FakeClock } from '@hype/core/testing';
import { describe, expect, it } from 'vitest';
import { classifyRequestUrl, RequestGovernor } from './governor.js';

function build(overrides: Record<string, number> = {}) {
  const clock = new FakeClock();
  const governor = new RequestGovernor({
    clock,
    sleeper: clock,
    rng: seededRng(99),
    ...overrides,
  });
  return { clock, governor };
}

describe('istek sınıflandırması', () => {
  it('yalnızca player ve next pahalı sınıftadır', () => {
    expect(classifyRequestUrl('https://www.youtube.com/youtubei/v1/next?key=x')).toBe('B');
    expect(classifyRequestUrl('https://www.youtube.com/youtubei/v1/player?key=x')).toBe('B');
    expect(classifyRequestUrl('https://www.youtube.com/youtubei/v1/browse?key=x')).toBe('A');
    expect(classifyRequestUrl('https://www.youtube.com/youtubei/v1/search?key=x')).toBe('A');
    expect(classifyRequestUrl('https://www.youtube.com/s/player/base.js')).toBe('A');
  });
});

describe('hız yöneticisi', () => {
  it('boştan sonra kısa bir seriye izin verir', async () => {
    const { clock, governor } = build({ burstCapacity: 3 });
    const start = clock.now();
    await governor.acquire('A');
    await governor.acquire('A');
    await governor.acquire('A');
    expect(clock.now()).toBe(start);
  });

  it('seri bittikten sonra istekler arasına insan-hızı boşluk koyar', async () => {
    const { clock, governor } = build({
      burstCapacity: 3,
      minIntervalMs: 1200,
      maxIntervalMs: 3200,
    });
    for (let i = 0; i < 3; i++) await governor.acquire('A');

    const before = clock.now();
    await governor.acquire('A');
    const gap = clock.now() - before;
    expect(gap).toBeGreaterThanOrEqual(1200);
    expect(gap).toBeLessThanOrEqual(3200);
  });

  it('boşluk sabit değil, jitter taşır (öngörülebilir ritim bot imzasıdır)', async () => {
    const { clock, governor } = build({
      burstCapacity: 1,
      minIntervalMs: 1000,
      maxIntervalMs: 3000,
    });
    const gaps: number[] = [];
    await governor.acquire('A');
    for (let i = 0; i < 6; i++) {
      const before = clock.now();
      await governor.acquire('A');
      gaps.push(clock.now() - before);
    }
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it('saatlik pahalı sınıf tavanı dolunca bekletir', async () => {
    const { clock, governor } = build({
      burstCapacity: 100,
      minIntervalMs: 1,
      maxIntervalMs: 1,
      hourlyClassBCap: 2,
    });
    await governor.acquire('B');
    await governor.acquire('B');

    const before = clock.now();
    await governor.acquire('B');
    // Üçüncü pahalı istek, ilkinin pencereden çıkmasını bekledi.
    expect(clock.now() - before).toBeGreaterThan(3_500_000);
  });

  it('pahalı sınıf tavanı ucuz istekleri engellemez', async () => {
    const { clock, governor } = build({
      burstCapacity: 100,
      minIntervalMs: 1,
      maxIntervalMs: 1,
      hourlyClassBCap: 1,
    });
    await governor.acquire('B');

    const before = clock.now();
    await governor.acquire('A');
    expect(clock.now() - before).toBeLessThan(1000);
  });

  it('toplam saatlik tavan da uygulanır', async () => {
    const { clock, governor } = build({
      burstCapacity: 100,
      minIntervalMs: 1,
      maxIntervalMs: 1,
      hourlyTotalCap: 3,
    });
    for (let i = 0; i < 3; i++) await governor.acquire('A');

    const before = clock.now();
    await governor.acquire('A');
    expect(clock.now() - before).toBeGreaterThan(3_500_000);
  });

  it('iptal edilen istek beklemeden döner', async () => {
    const { clock, governor } = build({
      burstCapacity: 1,
      minIntervalMs: 60_000,
      maxIntervalMs: 60_000,
    });
    await governor.acquire('A');

    const controller = new AbortController();
    controller.abort();
    const before = clock.now();
    await governor.acquire('A', controller.signal);
    expect(clock.now()).toBe(before);
  });

  it('istatistikler son bir saatlik hacmi raporlar', async () => {
    const { governor } = build({ burstCapacity: 10, minIntervalMs: 1, maxIntervalMs: 1 });
    await governor.acquire('A');
    await governor.acquire('B');
    await governor.acquire('B');
    expect(governor.stats.lastHourTotal).toBe(3);
    expect(governor.stats.lastHourClassB).toBe(2);
  });
});
