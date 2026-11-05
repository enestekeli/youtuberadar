/**
 * InnerTube sayıları ve tarihleri yerelleştirilmiş METİN olarak döndürür:
 * "1.2M views", "3 days ago", "12.3K subscribers". Oturum `lang: 'en'` ve
 * `location: 'US'` ile sabitlendiği için biçim öngörülebilir.
 *
 * Bu modülün tamamı saf ve yoğun test edilmiş: ayrıştırma hatası, sistemin en
 * sessiz bozulma yolu. Okunamayan bir değer ASLA 0 varsayılmaz — null döner ve
 * çağıran onu ayrı bir eleme sebebi olarak sayar.
 */

const UNIT_MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

const AGE_UNIT_DAYS: Record<string, number> = {
  second: 1 / 86_400,
  minute: 1 / 1440,
  hour: 1 / 24,
  day: 1,
  week: 7,
  month: 30.44,
  year: 365.25,
};

/** "1.2M views" → 1200000 · "1,234 views" → 1234 · "No views" → 0 · çöp → null */
export function parseCompactNumber(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (/\bno\s+\w+/.test(normalized)) return 0;

  const match = /(\d[\d.,]*)\s*([kmb])\b|(\d[\d.,]*)/.exec(normalized);
  if (match === null) return null;

  const [, withUnit, unit, plain] = match;
  if (withUnit !== undefined && unit !== undefined) {
    // Birim varsa nokta ondalık ayracıdır: "1.2M" → 1.2 × 10^6
    const value = Number.parseFloat(withUnit.replace(/,/g, ''));
    const multiplier = UNIT_MULTIPLIERS[unit];
    if (!Number.isFinite(value) || multiplier === undefined) return null;
    return Math.round(value * multiplier);
  }

  if (plain === undefined) return null;
  // Birim yoksa hem nokta hem virgül binlik ayracıdır: "1,234" → 1234
  const value = Number.parseInt(plain.replace(/[.,]/g, ''), 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * "3 days ago" → 3 · "Streamed 2 hours ago" → 0.083 · "LIVE" → null
 *
 * Ay ve yıl kaba yaklaşıklıklardır (30.44 / 365.25). Bu yüzden 60 günün
 * ötesinde YouTube'un metni "2 months ago"a düşer ve hassasiyet ±15 güne
 * çıkar — varsayılan 30 günlük yaş penceresinin sebeplerinden biri budur.
 */
export function parseRelativeAgeDays(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  /*
   * Kısa biçim de okunuyor: 2026-11-05'ten beri öneri rafı (LockupView)
   * "2 years ago" yerine "2y ago", "3mo ago", "5d ago" yazıyor. Uzun adlar
   * önce denenir; "mo" (ay) "m"den (dakika) önce gelmeli.
   */
  const match =
    /(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|[smhdwy])\b/i.exec(
      text,
    );
  if (match === null) return null;

  const amount = Number.parseInt(match[1] ?? '', 10);
  const unit = canonicalAgeUnit(match[2]);
  if (!Number.isFinite(amount) || unit === null) return null;

  const days = AGE_UNIT_DAYS[unit];
  return days === undefined ? null : amount * days;
}

function canonicalAgeUnit(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const u = raw.toLowerCase();
  if (u.startsWith('mo')) return 'month';
  if (u.startsWith('mi') || u === 'm') return 'minute';
  if (u.startsWith('s')) return 'second';
  if (u.startsWith('h')) return 'hour';
  if (u.startsWith('d')) return 'day';
  if (u.startsWith('w')) return 'week';
  if (u.startsWith('y')) return 'year';
  return null;
}

/** "12:34" → 754 · "1:02:03" → 3723 · "LIVE" → null */
export function parseDurationText(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  const parts = text.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  let seconds = 0;
  for (const part of parts) {
    const value = Number.parseInt(part, 10);
    if (!Number.isFinite(value) || value < 0) return null;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * "Joined Mar 4, 2024" → epoch ms · çöz&uuml;lemezse null
 *
 * Kanal modunun "kısa sürede açılmış" iddiasının tek güvenilir kaynağı.
 * Kanalın son yüklemelerinin yaşına bakmak yanıltıcı olurdu: Videos sekmesinin
 * yalnızca ilk sayfasını (~30 video) görüyoruz, yani sık yükleyen ESKİ bir
 * kanal da tamamen genç videolarla görünür.
 *
 * `Date.parse` KULLANILMIYOR: yerel saat dilimine ve motora göre değişiyor,
 * bir günlük kayma bile "5 ay 29 gün" ile "6 ay 1 gün" arasındaki kararı
 * çevirebilir. Ay adı tablosu + `Date.UTC` ile deterministik ayrıştırıyoruz.
 *
 * Oturum `lang: 'en'` ile sabitlendiği için biçim öngörülebilir; "Joined" öneki
 * yine de opsiyonel bırakıldı (savunmacı).
 */
export function parseJoinedDate(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  const match = /([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  if (match === null) return null;

  const month = MONTHS[(match[1] ?? '').slice(0, 3).toLowerCase()];
  const day = Number.parseInt(match[2] ?? '', 10);
  const year = Number.parseInt(match[3] ?? '', 10);
  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  if (day < 1 || day > 31 || year < 2005 || year > 2100) return null;

  return Date.UTC(year, month, day);
}

/**
 * "12.3K subscribers" → 12300
 *
 * YouTube abone sayısını üç anlamlı basamağa yuvarlar; gerçek değer
 * 12.250–12.349 arasında herhangi bir şey olabilir. Bu yüzden 1.000–50.000
 * bandının kenarları doğası gereği bulanıktır ve sayı arayüzde asla "kesin"
 * gibi sunulmaz.
 */
export function parseSubscriberCount(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  if (/\bhidden\b/i.test(text)) return null;
  return parseCompactNumber(text);
}

/** Kanalın gizli abone sayısı beyanı — reddetme sebebi değil, yalnızca bir bayrak. */
export function looksLikeHiddenSubscribers(text: string | null | undefined): boolean {
  return typeof text === 'string' && /\bhidden\b/i.test(text);
}
