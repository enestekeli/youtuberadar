import { GatewayError } from '@hype/core';

/**
 * Araştırmanın en önemli pratik bulgusu: InnerTube kısıtlarken çoğu zaman temiz
 * bir HTTP 429 döndürmez. Bunun yerine yapısal olarak geçerli ama anlamsal
 * olarak boş yanıtlar verir ya da "bot değilsin" duvarına çarptırır.
 *
 * Bu modül, kütüphanenin ve ağın ürettiği her şeyi motorun anladığı beş
 * kategoriye indirger. Motorun mola mantığı buna bakarak çalışır, dolayısıyla
 * sınıflandırmanın doğruluğu ban riskini doğrudan belirler.
 */

const BOT_WALL_PATTERNS = [
  /sign in to confirm/i,
  /confirm you'?re not a bot/i,
  /LOGIN_REQUIRED/i,
  /not a bot/i,
];

const SOFT_THROTTLE_PATTERNS = [
  /content isn'?t available.*try again later/i,
  /try again later/i,
  /too many requests/i,
  /rate.?limit/i,
];

const NOT_FOUND_PATTERNS = [
  /video unavailable/i,
  /this video is (private|unavailable)/i,
  /channel (does not exist|not found)/i,
  /does not exist/i,
  /has been removed/i,
  /account (has been )?terminated/i,
];

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function classifyError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;

  const message = messageOf(error);
  const status = statusOf(error);

  if (status === 429) return new GatewayError('throttled_soft', message);
  if (status === 401 || status === 403) return new GatewayError('login_required', message);
  if (status === 404) return new GatewayError('not_found', message);
  if (status !== null && status >= 500) return new GatewayError('network', message, true);

  if (BOT_WALL_PATTERNS.some((p) => p.test(message))) {
    return new GatewayError('login_required', message);
  }
  if (SOFT_THROTTLE_PATTERNS.some((p) => p.test(message))) {
    return new GatewayError('throttled_soft', message);
  }
  if (NOT_FOUND_PATTERNS.some((p) => p.test(message))) {
    return new GatewayError('not_found', message);
  }

  // youtubei.js ayrıştırma hataları: yanıt geldi ama beklenen yapıda değil.
  // Bu, YouTube'un şema değiştirmesi kadar sessiz kısıtlama da olabilir.
  if (/parsing|InnertubeError|ParsingError/i.test(message)) {
    return new GatewayError('parse_empty', message);
  }

  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket/i.test(message)) {
    return new GatewayError('network', message, true);
  }

  return new GatewayError('network', message, true);
}

type PlayabilityStatus = { status?: string; reason?: string } | null | undefined;

/**
 * Yalnızca KİMLİK sorununu yakalar — tarama yolunda kullanılır.
 *
 * Bir videonun oynatılamaz olması bizi ilgilendirmez: öneri rafı yine gelir ve
 * o bağlantılar graf için tamamen geçerlidir. Canlı testte ilk arama sonucunun
 * "Video unavailable" dönüp yine de 20 komşu taşıması bunu gösterdi;
 * oynatılabilirliğe takılmak sağlam kenarları çöpe atmak olurdu.
 *
 * LOGIN_REQUIRED ise başka: o, videonun değil bizim sorunumuz — bot duvarı.
 */
export function assertNotBotWalled(status: PlayabilityStatus): void {
  if (status === null || status === undefined) return;
  if ((status.status?.toUpperCase() ?? '') === 'LOGIN_REQUIRED') {
    throw new GatewayError('login_required', status.reason ?? 'LOGIN_REQUIRED');
  }
}

/**
 * Tam oynatılabilirlik denetimi — yalnızca export zenginleştirmesinde.
 * Orada videonun kendi verisini (açıklama, kesin tarih, beğeni) istiyoruz,
 * dolayısıyla oynatılamayan bir video gerçekten işe yaramaz.
 */
export function assertPlayable(status: PlayabilityStatus): void {
  assertNotBotWalled(status);
  if (status === null || status === undefined) return;
  const state = status.status?.toUpperCase() ?? '';
  if (state === 'AGE_VERIFICATION_REQUIRED') {
    throw new GatewayError('login_required', status.reason ?? state);
  }
  if (state === 'ERROR' || state === 'UNPLAYABLE') {
    throw new GatewayError('not_found', status.reason ?? state);
  }
}
