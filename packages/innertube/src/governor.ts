import type { Clock, Rng, Sleeper } from '@hype/core';

/**
 * İstek sınıfı. YouTube'un gerçekte ölçtüğü sınıf B'dir (yt-dlp ölçümü:
 * misafir oturumda ~300 video/saat); browse çağrıları çok daha ucuzdur.
 */
export type RequestClass = 'A' | 'B';

const HOUR_MS = 3_600_000;

export interface GovernorOptions {
  clock: Clock;
  sleeper: Sleeper;
  rng: Rng;
  /** Jitter aralığının alt/üst sınırı (varsayılan 1200–3200 ms, ortalama ~2.2 sn). */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** Boştan sonra izin verilen ani seri (insan davranışına daha yakın). */
  burstCapacity?: number;
  hourlyTotalCap?: number;
  hourlyClassBCap?: number;
}

interface Dispatch {
  ts: number;
  cls: RequestClass;
}

/**
 * Hız yöneticisi.
 *
 * Enjekte edilen `fetch` içinde çalışır; bu sayede youtubei.js'in attığı HER
 * HTTP isteği — `getInfo()`'nun içeride yaptığı çift istek dahil — fiziksel
 * olarak buradan geçer. Kütüphanenin herhangi bir kod yolu hız ayarını
 * atlayamaz.
 *
 * İki katman: jitter'lı jeton kovası (istekler arası insan-hızı boşluk) ve
 * kayan saatlik tavanlar (uzun taramaların toplam hacmi).
 */
export class RequestGovernor {
  private readonly baseMinIntervalMs: number;
  private readonly baseMaxIntervalMs: number;
  private minIntervalMs: number;
  private maxIntervalMs: number;
  private readonly burstCapacity: number;
  /*
   * Tavanlar ve bekleme çalışırken değişebilir: nabız denetleyicisi
   * (`pulse.ts`) YouTube'un tepkisine göre `setLimits` çağırır.
   */
  private hourlyTotalCap: number;
  private hourlyClassBCap: number;
  private intervalScale = 1;

  private tokens: number;
  private nextTokenAt: number;
  private dispatches: Dispatch[] = [];
  /** Eşzamanlılık 1: istekler tek sıra hâlinde ilerler. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GovernorOptions) {
    this.baseMinIntervalMs = options.minIntervalMs ?? 1200;
    this.baseMaxIntervalMs = options.maxIntervalMs ?? 3200;
    this.minIntervalMs = this.baseMinIntervalMs;
    this.maxIntervalMs = this.baseMaxIntervalMs;
    this.burstCapacity = options.burstCapacity ?? 3;
    this.hourlyTotalCap = options.hourlyTotalCap ?? 700;
    this.hourlyClassBCap = options.hourlyClassBCap ?? 200;
    this.tokens = this.burstCapacity;
    this.nextTokenAt = options.clock.now();
  }

  get stats(): {
    lastHourTotal: number;
    lastHourClassB: number;
    tokens: number;
    hourlyTotalCap: number;
    hourlyClassBCap: number;
    intervalScale: number;
  } {
    const cutoff = this.options.clock.now() - HOUR_MS;
    const recent = this.dispatches.filter((d) => d.ts > cutoff);
    return {
      lastHourTotal: recent.length,
      lastHourClassB: recent.filter((d) => d.cls === 'B').length,
      tokens: this.tokens,
      hourlyTotalCap: this.hourlyTotalCap,
      hourlyClassBCap: this.hourlyClassBCap,
      intervalScale: this.intervalScale,
    };
  }

  /** Nabız ayarı: saatlik tavanlar ve istek arası bekleme çarpanı. */
  setLimits(limits: {
    hourlyTotalCap: number;
    hourlyClassBCap: number;
    intervalScale: number;
  }): void {
    this.hourlyTotalCap = Math.max(1, Math.round(limits.hourlyTotalCap));
    this.hourlyClassBCap = Math.max(1, Math.round(limits.hourlyClassBCap));
    this.intervalScale = limits.intervalScale > 0 ? limits.intervalScale : 1;
    this.minIntervalMs = this.baseMinIntervalMs * this.intervalScale;
    this.maxIntervalMs = this.baseMaxIntervalMs * this.intervalScale;
  }

  /** İstek izni bekler. Sıraya girer; iptal edilirse beklemeden döner. */
  acquire(cls: RequestClass, signal?: AbortSignal): Promise<void> {
    const run = this.queue.then(() => this.doAcquire(cls, signal));
    // Zincir kopmasın: bir bekleyişin hatası sıradakini engellememeli.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doAcquire(cls: RequestClass, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted === true) return;
      const now = this.options.clock.now();
      this.prune(now);

      const windowWait = this.windowWait(cls, now);
      if (windowWait > 0) {
        await this.options.sleeper.sleep(windowWait, signal);
        continue;
      }

      this.refill(now);
      if (this.tokens < 1) {
        await this.options.sleeper.sleep(Math.max(1, this.nextTokenAt - now), signal);
        continue;
      }

      this.consume(now);
      this.dispatches.push({ ts: now, cls });
      return;
    }
  }

  private refill(now: number): void {
    while (this.tokens < this.burstCapacity && this.nextTokenAt <= now) {
      this.tokens += 1;
      this.nextTokenAt += this.sampleIntervalMs();
    }
  }

  private consume(now: number): void {
    this.tokens -= 1;
    // Kova boşaldığında bir sonraki jetonun zamanı şimdiden ileri kurulur;
    // aksi hâlde geçmişte kalmış bir zaman damgası seri isteklere yol açardı.
    if (this.nextTokenAt <= now) this.nextTokenAt = now + this.sampleIntervalMs();
  }

  /** Saatlik tavan dolduysa en eski isteğin pencereden çıkmasına kalan süre. */
  private windowWait(cls: RequestClass, now: number): number {
    const cutoff = now - HOUR_MS;
    const recent = this.dispatches.filter((d) => d.ts > cutoff);

    if (recent.length >= this.hourlyTotalCap) {
      const oldest = recent[0];
      if (oldest !== undefined) return Math.max(1, oldest.ts + HOUR_MS - now);
    }

    if (cls === 'B') {
      const classB = recent.filter((d) => d.cls === 'B');
      if (classB.length >= this.hourlyClassBCap) {
        const oldest = classB[0];
        if (oldest !== undefined) return Math.max(1, oldest.ts + HOUR_MS - now);
      }
    }

    return 0;
  }

  private prune(now: number): void {
    const cutoff = now - HOUR_MS;
    if (this.dispatches.length > 0 && (this.dispatches[0]?.ts ?? now) <= cutoff) {
      this.dispatches = this.dispatches.filter((d) => d.ts > cutoff);
    }
  }

  private sampleIntervalMs(): number {
    const span = this.maxIntervalMs - this.minIntervalMs;
    return this.minIntervalMs + this.options.rng.next() * span;
  }
}

/**
 * URL'den istek sınıfı. Yalnızca `/player` ve `/next` pahalı sayılır; browse,
 * search ve guide çağrıları ucuz sınıftadır.
 */
export function classifyRequestUrl(url: string): RequestClass {
  return /\/youtubei\/v1\/(player|next)\b/.test(url) ? 'B' : 'A';
}
