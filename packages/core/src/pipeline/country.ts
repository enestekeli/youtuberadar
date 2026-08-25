/**
 * Ülke eşleştirme.
 *
 * YouTube ülke adını yerelleştirilmiş biçimde döndürebiliyor ("Türkiye"),
 * kullanıcı ise "Turkey" yazmış olabilir. Ham metin karşılaştırması bu yüzden
 * yetmiyor: aksanlar sadeleştiriliyor ve yaygın karşılıklar eşleniyor.
 */

/** Aynı ülkenin farklı yazımları. Hepsi küçük harfe ve aksansıza indirgenmiş. */
const ALIASES: readonly (readonly string[])[] = [
  ['turkiye', 'turkey', 'tr'],
  ['united states', 'united states of america', 'usa', 'us', 'amerika', 'abd'],
  ['united kingdom', 'uk', 'great britain', 'britain', 'ingiltere'],
  ['germany', 'deutschland', 'almanya', 'de'],
  ['france', 'fransa', 'fr'],
  ['netherlands', 'holland', 'hollanda', 'nl'],
  ['azerbaijan', 'azerbaycan', 'az'],
  ['russia', 'rusya', 'ru'],
  ['spain', 'espana', 'ispanya', 'es'],
  ['italy', 'italia', 'italya', 'it'],
  ['japan', 'japonya', 'jp'],
  ['south korea', 'korea', 'kore', 'kr'],
  ['india', 'hindistan', 'in'],
  ['brazil', 'brasil', 'brezilya', 'br'],
];

/** Küçük harf + aksansız + tek boşluk. */
export function normalizeCountry(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasGroup(normalized: string): readonly string[] | null {
  return ALIASES.find((group) => group.includes(normalized)) ?? null;
}

/** İki ülke adı aynı ülkeyi mi gösteriyor? */
export function sameCountry(a: string, b: string): boolean {
  const left = normalizeCountry(a);
  const right = normalizeCountry(b);
  if (left === right) return true;

  const group = aliasGroup(left);
  return group?.includes(right) === true;
}

export type CountryVerdict = 'accepted' | 'mismatch' | 'unknown';

/**
 * Kanalın ülkesi kullanıcının listesine uyuyor mu?
 *
 * Ülke bilinmiyorsa karar kullanıcıya bırakılıyor: bazı kanallar ülkelerini
 * beyan etmiyor ve onları körü körüne elemek gerçek bulguları kaçırtabilir.
 */
export function checkCountry(
  country: string | null,
  wanted: readonly string[] | null,
  allowUnknown: boolean,
): CountryVerdict {
  if (wanted === null || wanted.length === 0) return 'accepted';
  if (country === null || country.trim().length === 0) {
    return allowUnknown ? 'accepted' : 'unknown';
  }
  return wanted.some((candidate) => sameCountry(country, candidate)) ? 'accepted' : 'mismatch';
}

/** Ülke filtresi açık mı? Kapalıysa hiç istek harcanmaz. */
export function countryFilterActive(wanted: readonly string[] | null): boolean {
  return wanted !== null && wanted.length > 0;
}
