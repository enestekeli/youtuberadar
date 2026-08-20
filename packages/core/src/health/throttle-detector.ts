import type { GatewayErrorKind, ThrottleCause } from '@hype/shared';
import type { Clock } from '../ports/clock.js';

export interface ThrottleTrip {
  cause: ThrottleCause;
  cooldownMs: number;
  /** Ardışık kaçıncı tetiklenme — her seferinde cooldown ikiye katlanır. */
  level: number;
}

const MINUTE = 60_000;

/** İki 429 bu pencere içinde gelirse gerçek bir kısıtlama sayılır. */
export const HTTP_429_WINDOW_MS = 10 * MINUTE;
export const HTTP_429_BASE_COOLDOWN_MS = 15 * MINUTE;

/** Bot duvarı: tek sinyal yeter, ve mola uzundur. */
export const BOT_WALL_BASE_COOLDOWN_MS = 45 * MINUTE;

/** Üst üste boş gelen feed'ler, sessiz kısıtlamanın en yaygın imzası. */
export const EMPTY_FEED_TRIP_COUNT = 3;
export const EMPTY_FEED_BASE_COOLDOWN_MS = 30 * MINUTE;

export const MAX_COOLDOWN_MS = 4 * 60 * MINUTE;

/** Bu kadar ardışık başarılı istekten sonra ceza seviyesi sıfırlanır. */
export const LEVEL_RESET_AFTER_SUCCESSES = 10;

/**
 * Kısıtlama sezgisi.
 *
 * Araştırmanın en önemli bulgusu buraya kodlanmış: InnerTube kısıtlarken çoğu
 * zaman temiz bir HTTP 429 döndürmez — sessizce bozulur. "Sign in to confirm
 * you're not a bot", "content isn't available", ya da hiç video içermeyen bir
 * feed. Yalnızca durum koduna bakan bir yeniden deneme döngüsü hem kısıtlamayı
 * kaçırır hem de veriyi bozar.
 *
 * Bu yüzden sezgi semantiktir ve karar zamana çevrilir: öğe hataları sayaca,
 * kimlik hataları molaya dönüşür.
 */
export class ThrottleDetector {
  private recent429s: number[] = [];
  private consecutiveEmptyFeeds = 0;
  private consecutiveSuccesses = 0;
  private level = 0;

  constructor(private readonly clock: Clock) {}

  recordSuccess(): void {
    this.consecutiveEmptyFeeds = 0;
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses >= LEVEL_RESET_AFTER_SUCCESSES) {
      this.level = 0;
      this.consecutiveSuccesses = 0;
    }
  }

  /** Yapısal olarak geçerli ama hiç video içermeyen bir yanıt. */
  recordEmptyFeed(): ThrottleTrip | null {
    this.consecutiveSuccesses = 0;
    this.consecutiveEmptyFeeds += 1;
    if (this.consecutiveEmptyFeeds < EMPTY_FEED_TRIP_COUNT) return null;
    return this.trip('empty_feeds', EMPTY_FEED_BASE_COOLDOWN_MS);
  }

  recordError(kind: GatewayErrorKind): ThrottleTrip | null {
    this.consecutiveSuccesses = 0;

    if (kind === 'login_required') {
      return this.trip('login_required', BOT_WALL_BASE_COOLDOWN_MS);
    }

    if (kind === 'throttled_soft') {
      const now = this.clock.now();
      this.recent429s = this.recent429s.filter((t) => now - t < HTTP_429_WINDOW_MS);
      this.recent429s.push(now);
      if (this.recent429s.length < 2) return null;
      this.recent429s = [];
      return this.trip('http_429', HTTP_429_BASE_COOLDOWN_MS);
    }

    if (kind === 'parse_empty') return this.recordEmptyFeed();

    // network / not_found: tek videonun sorunu, kimliğin değil.
    return null;
  }

  private trip(cause: ThrottleCause, baseMs: number): ThrottleTrip {
    this.consecutiveEmptyFeeds = 0;
    const cooldownMs = Math.min(baseMs * 2 ** this.level, MAX_COOLDOWN_MS);
    this.level += 1;
    return { cause, cooldownMs, level: this.level };
  }
}
