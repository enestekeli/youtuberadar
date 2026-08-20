/**
 * Bölge sabitleri.
 *
 * `gl` (ülke) ile `hl` (dil) BİLİNÇLİ olarak ayrı tutuluyor. `hl` bu projede
 * kilitli: `text-parse.ts` İngilizce metne çivili ("3 days ago", "12.3K
 * subscribers", "hidden") ve `hl` değişirse tüm ayrıştırıcı sessizce bozulur —
 * sistemin en tehlikeli bozulma yolu. `gl` ise metin dilinden bağımsız,
 * serbestçe değiştirilebilir.
 *
 * Aynı ayrımı Invidious da yapıyor: `hl` sabit `"en"`, yalnızca `gl` değişken
 * (`iv-org/invidious`, `youtube_api.cr`).
 */

/**
 * Zaman dilimi, bölgeyle TUTARLI olmalı.
 *
 * `gl: 'TR'` beyan edip `timeZone: 'America/New_York'` göndermek çelişkili bir
 * parmak izi üretir. Listede olmayan bir bölge için UTC dönülür: yanlış bir
 * tahminden iyidir.
 */
const TIMEZONES: Record<string, string> = {
  US: 'America/New_York',
  TR: 'Europe/Istanbul',
  DE: 'Europe/Berlin',
  GB: 'Europe/London',
  FR: 'Europe/Paris',
  ES: 'Europe/Madrid',
  IT: 'Europe/Rome',
  NL: 'Europe/Amsterdam',
  RU: 'Europe/Moscow',
  IN: 'Asia/Kolkata',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  CN: 'Asia/Shanghai',
  ID: 'Asia/Jakarta',
  SA: 'Asia/Riyadh',
  AE: 'Asia/Dubai',
  BR: 'America/Sao_Paulo',
  MX: 'America/Mexico_City',
  AR: 'America/Argentina/Buenos_Aires',
  CA: 'America/Toronto',
  AU: 'Australia/Sydney',
  EG: 'Africa/Cairo',
  NG: 'Africa/Lagos',
  ZA: 'Africa/Johannesburg',
};

/*
 * Arayüzün sunduğu bölge LİSTESİ burada değil, `@hype/shared`'da (`REGIONS`):
 * web paketi yalnızca shared'ı import edebiliyor (hexagon kuralı) ve listeyi iki
 * yerde tutmak kaçınılmaz olarak birbirinden ayrışırdı. Buradaki tablo yalnızca
 * zaman dilimi eşlemesi — bir adaptör detayı. Listede olmayan kod UTC'ye düşer.
 */
export function timezoneFor(region: string | null | undefined): string {
  if (typeof region !== 'string') return 'UTC';
  return TIMEZONES[region.toUpperCase()] ?? 'UTC';
}

/**
 * YouTube'un coğrafya tercihi çerezi.
 *
 * ASIL KALDIRAÇ BUDUR — istek gövdesindeki `gl` değil. Ölçüldü (8 Ağu 2026,
 * `tools/region-probe.ts`, Türk IP'sinden): hiçbir sinyal göndermeyince YouTube
 * bizi TR sanıyor; `PREF=gl=DE` çerezi gönderince DE sanıyor. Yani beyan, IP
 * tabanlı çıkarımı geçersiz kılıyor.
 *
 * `hl=en` bilinçli sabit — `text-parse.ts` İngilizce metne bağımlı.
 * Zaman dilimindeki `/` YouTube'un beklediği gibi `.` olur (kütüphanenin kendi
 * `PREF=tz=` biçimiyle aynı).
 */
export function prefCookie(region: string | null | undefined): string {
  const tz = timezoneFor(region).replace(/\//g, '.');
  if (typeof region !== 'string' || region.length === 0) return `PREF=hl=en&tz=${tz}`;
  return `PREF=gl=${region.toUpperCase()}&hl=en&tz=${tz}`;
}

/**
 * Geçerli bölgeyi taşıma katmanıyla paylaşan değişken kutu.
 *
 * Neden gerekli: bölge çerezi `Innertube.create({ cookie })` ile verilemiyor.
 * O yol iki sebeple yanlış —
 *   1. Kütüphane çerezi yalnızca `session.logged_in && is_innertube_req`
 *      koşulunda ekliyor (`HTTPClient.js`), ve `logged_in = !!cookie` olduğu için
 *      çerez vermek oturumu "giriş yapılmış" gibi işaretliyordu; anonim bir
 *      araç için yanlış bir beyan.
 *   2. Daha önemlisi, oturum açılışındaki İLK istek (`POST /youtubei/v1/config`)
 *      `HTTPClient`'tan hiç geçmiyor — ham `fetch` ile ve sabit başlıklarla
 *      atılıyor. Yani çerez tam da kullanıcının önemsediği ilk pinge ulaşmıyordu.
 *
 * Çözüm: çerezi `governedFetch` seviyesinde damgalamak. Oradan YouTube'a giden
 * her istek geçiyor, açılış isteği dahil.
 *
 * `AbortSignalHolder` ile aynı fikir — bu depoda yerleşik bir kalıp.
 */
export class RegionHolder {
  constructor(private region: string) {}

  get current(): string {
    return this.region;
  }

  set(region: string): void {
    this.region = region;
  }

  cookie(): string {
    return prefCookie(this.region);
  }
}
