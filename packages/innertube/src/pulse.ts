/**
 * NABIZ — hız limitlerini YouTube'un tepkisine göre ayarlayan denetleyici.
 *
 * Kullanıcı (2026-11-05): "limit kısmı dinamik olsun, nabza göre şerbet".
 * Sabit tavan ya fazla temkinli (bütçe 4,5 dakikada bitiyordu) ya da fazla
 * cesur kalıyordu. Burada TCP'nin tıkanıklık denetimiyle aynı fikir (AIMD):
 *
 *   • Sakin geçen her pencerede (varsayılan 10 dk) ve tavana gerçekten
 *     dayanıyorsak tavan biraz BÜYÜR, istek arası bekleme biraz KISALIR.
 *     Tavanı kullanmıyorsak büyütmek anlamsız — yalnızca risk birikir.
 *   • Uyarı (tek 429, boş feed) gelince tavan %15 KÜÇÜLÜR.
 *   • Mola (kısıtlama tetiklendi) gelince tavan %40 küçülür, bekleme uzar,
 *     ve büyüme bir süre (varsayılan 30 dk) dondurulur.
 *
 * Saf ve deterministik: saat dışarıdan verilir, durum JSON'a dökülüp
 * geri yüklenebilir (sunucu yeniden başlayınca öğrenilen limit kaybolmasın).
 */

export interface PulseLimits {
  hourlyTotalCap: number;
  hourlyClassBCap: number;
  /** İstek arası bekleme çarpanı: 1 = 1,2–3,2 sn; 1,5 = 1,8–4,8 sn. */
  intervalScale: number;
}

export interface PulseBounds {
  min: PulseLimits;
  max: PulseLimits;
}

export const DEFAULT_PULSE_START: PulseLimits = {
  hourlyTotalCap: 1100,
  hourlyClassBCap: 350,
  intervalScale: 1,
};

export const DEFAULT_PULSE_BOUNDS: PulseBounds = {
  min: { hourlyTotalCap: 300, hourlyClassBCap: 80, intervalScale: 0.7 },
  max: { hourlyTotalCap: 2400, hourlyClassBCap: 700, intervalScale: 3 },
};

const MINUTE = 60_000;
export const PULSE_CALM_WINDOW_MS = 10 * MINUTE;
export const PULSE_FREEZE_AFTER_COOLDOWN_MS = 30 * MINUTE;
/** Tavan kullanımı bunun üstündeyse "dayanıyoruz" sayılır. */
export const PULSE_PRESSURE_RATIO = 0.8;

export type PulseMood = 'hızlanıyor' | 'sabit' | 'yavaşladı' | 'molada';

export interface PulseState {
  limits: PulseLimits;
  mood: PulseMood;
  /** Son ayarın tek satırlık sebebi — panelde/sağlıkta gösterilir. */
  reason: string;
  lastChangeAt: number;
  lastTroubleAt: number | null;
  frozenUntil: number | null;
}

export interface PulseUsage {
  lastHourTotal: number;
  lastHourClassB: number;
}

export class PulseController {
  private state: PulseState;

  constructor(
    private readonly now: () => number,
    initial: Partial<PulseState> | null = null,
    private readonly bounds: PulseBounds = DEFAULT_PULSE_BOUNDS,
  ) {
    const t = now();
    this.state = {
      limits: this.clamp(initial?.limits ?? DEFAULT_PULSE_START),
      mood: initial?.mood ?? 'sabit',
      reason: initial?.reason ?? 'başlangıç',
      lastChangeAt: initial?.lastChangeAt ?? t,
      lastTroubleAt: initial?.lastTroubleAt ?? null,
      frozenUntil: initial?.frozenUntil ?? null,
    };
  }

  get snapshot(): PulseState {
    return { ...this.state, limits: { ...this.state.limits } };
  }

  /** Kısıtlama tetiklendi (mola başladı): sert yavaşla, büyümeyi dondur. */
  onCooldown(cause: string): PulseLimits {
    const t = this.now();
    const l = this.state.limits;
    this.set(
      {
        hourlyTotalCap: Math.round(l.hourlyTotalCap * 0.6),
        hourlyClassBCap: Math.round(l.hourlyClassBCap * 0.6),
        intervalScale: l.intervalScale * 1.5,
      },
      'molada',
      `YouTube molası (${cause}) — tavan %40 düştü`,
      t,
    );
    this.state.lastTroubleAt = t;
    this.state.frozenUntil = t + PULSE_FREEZE_AFTER_COOLDOWN_MS;
    return this.state.limits;
  }

  /** Mola sayılmayan uyarı (tek 429, boş feed, giriş istendi): hafif yavaşla. */
  onWarning(what: string): PulseLimits {
    const t = this.now();
    const l = this.state.limits;
    this.set(
      {
        hourlyTotalCap: Math.round(l.hourlyTotalCap * 0.85),
        hourlyClassBCap: Math.round(l.hourlyClassBCap * 0.85),
        intervalScale: l.intervalScale * 1.1,
      },
      'yavaşladı',
      `uyarı: ${what} — tavan %15 düştü`,
      t,
    );
    this.state.lastTroubleAt = t;
    return this.state.limits;
  }

  /**
   * Periyodik nabız. Sakin bir pencere geçtiyse ve tavana dayanıyorsak büyür.
   * Değişiklik olduysa yeni limitleri, olmadıysa null döner.
   */
  tick(usage: PulseUsage): PulseLimits | null {
    const t = this.now();
    if (this.state.frozenUntil !== null && t < this.state.frozenUntil) return null;
    if (t - this.state.lastChangeAt < PULSE_CALM_WINDOW_MS) return null;
    if (this.state.lastTroubleAt !== null && t - this.state.lastTroubleAt < PULSE_CALM_WINDOW_MS)
      return null;

    const l = this.state.limits;
    const pressure = Math.max(
      usage.lastHourTotal / l.hourlyTotalCap,
      usage.lastHourClassB / l.hourlyClassBCap,
    );
    if (pressure < PULSE_PRESSURE_RATIO) {
      // Tavanı kullanmıyoruz: büyütme, ama yavaş moddan sakin moda dön.
      if (this.state.mood !== 'sabit') {
        this.state.mood = 'sabit';
        this.state.reason = 'sakin, tavan dolmuyor';
        this.state.lastChangeAt = t;
      }
      return null;
    }

    const before = { ...l };
    this.set(
      {
        hourlyTotalCap: l.hourlyTotalCap + 100,
        hourlyClassBCap: l.hourlyClassBCap + 30,
        intervalScale: l.intervalScale * 0.95,
      },
      'hızlanıyor',
      `10 dk sorunsuz ve tavan dolu (%${Math.round(pressure * 100)}) — tavan büyüdü`,
      t,
    );
    const after = this.state.limits;
    const changed =
      after.hourlyTotalCap !== before.hourlyTotalCap ||
      after.hourlyClassBCap !== before.hourlyClassBCap ||
      after.intervalScale !== before.intervalScale;
    if (!changed) {
      this.state.mood = 'sabit';
      this.state.reason = 'üst sınırda';
      return null;
    }
    return after;
  }

  private set(next: PulseLimits, mood: PulseMood, reason: string, t: number): void {
    this.state.limits = this.clamp(next);
    this.state.mood = mood;
    this.state.reason = reason;
    this.state.lastChangeAt = t;
  }

  private clamp(l: PulseLimits): PulseLimits {
    const { min, max } = this.bounds;
    const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    return {
      hourlyTotalCap: Math.round(c(l.hourlyTotalCap, min.hourlyTotalCap, max.hourlyTotalCap)),
      hourlyClassBCap: Math.round(c(l.hourlyClassBCap, min.hourlyClassBCap, max.hourlyClassBCap)),
      intervalScale:
        Math.round(c(l.intervalScale, min.intervalScale, max.intervalScale) * 1000) / 1000,
    };
  }
}
