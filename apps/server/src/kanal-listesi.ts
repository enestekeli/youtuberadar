/**
 * Kanal listesi — "bizim sistem" süzgecinin saf mantığı.
 *
 * `tools/export-channels.mts` veritabanından okur, burası karar verir, o yine
 * CSV/HTML yazar. Ayrı durmasının sebebi test: durum kuralları (aday /
 * izlemede / elendi) kullanıcıyla konuşulup değişen tek yer ve her değişiklik
 * bir testle sabitlenmeli.
 *
 * Hiçbir istek atmaz: kanalın yakalandığı andaki anlık görüntüsü
 * (`channels.uploads_json`) kullanılır, görüntüdeki yaşlar geçen süre kadar
 * ileri taşınır.
 *
 * Anlam gerektiren puanlar (kategori, üretilebilirlik, formül benzerliği,
 * görsel tipi) burada HESAPLANMIYOR — kelime eşleştirmeyle güvenilir çıkmadığı
 * ölçüldü. `exports/siniflama.json`'dan okunur; o dosyayı Claude
 * `exports/siniflama-girdi.json`'a bakarak doldurur.
 */
import { checkTopic, detectLanguage, median } from '@hype/core';
import {
  ELIMINATED_CATEGORIES,
  LONG_VIDEO_SEC,
  MIN_PRODUCIBILITY,
  OUR_DURATION_MAX,
  OUR_DURATION_MIN,
  OUR_EXCLUDE_TERMS,
  OUR_MAX_CHANNEL_AGE_DAYS,
  OUR_MIN_MEDIAN_VIEWS,
  OWN_CHANNEL_IDS,
  PRODUCIBILITY_CAP,
  type RawVideoCard,
  SLEEP_PATTERN,
  VISUAL_TYPES,
} from '@hype/shared';
import { z } from 'zod';

const DAY = 86_400_000;

/** Güvenilir medyan için en az uzun video; altı "izlemede". */
export const MIN_LONG_VIDEOS = 8;
/**
 * Kanal etkin mi: anlık görüntüden önceki 30 günde en az bu kadar yükleme
 * (2026-10-23 revizyonundaki güvenilirlik şartı).
 */
export const MIN_UPLOADS_30D = 6;
/** Son N olgun uzun video medyana girer. */
export const RECENT_N = 10;
/** Henüz izlenmesi oturmamış video medyana girmez. */
export const MIN_VIDEO_AGE_DAYS = 2;
/** İvme = son 5 / önceki 5 medyan; bunun altı "sönüyor". */
export const MOMENTUM_N = 5;
export const FADING_RATIO = 0.3;
/**
 * Tek vuruş: en iyi video medyanın 5 katından büyük ve son 5'in medyanı en
 * iyinin %5'inden küçük. (Hızlı PK taraması: hızlı geçenlerin yarısının son
 * videoları en iyinin ~%4'ü.) %10 fazla geniş çıktı: 5,1 M vuruşlu, son
 * videoları ~450 B alan The Last Day'i de "tek vuruş" sayıyordu.
 */
export const ONE_HIT_BEST_FACTOR = 5;
export const ONE_HIT_RECENT_RATIO = 0.05;
/** Patlama = medyanın 3 katı. */
export const BURST_FACTOR = 3;
/** Başlıkların bu oranı yasak tür / uyku ise kanal elenir. */
export const BANNED_TITLE_SHARE = 0.25;

const INDIC_PATTERN = /[ऀ-ॿঀ-৿஀-௿ఀ-౿]/;
const INDIC_WORDS = /\b(hindi|urdu|tamil|telugu|bangla|bengali|marathi)\b/i;

export const ClassificationSchema = z.record(
  z.string(),
  z.object({
    kategori: z.string(),
    alt_nis: z.string().optional(),
    uretilebilirlik: z.number().min(0).max(5),
    formul_benzerligi: z.number().min(0).max(5),
    gorsel_tipi: z.enum(VISUAL_TYPES).optional(),
    /** Gerçek kişi taklidi, kehanet, korku/günah tıklama yemi. */
    politika_riski: z.boolean().optional(),
    not: z.string().optional(),
  }),
);
export type Classification = z.infer<typeof ClassificationSchema>[string];

export type Status = 'referans' | 'aday' | 'izlemede' | 'elendi';
export const STATUS_ORDER: Record<Status, number> = {
  referans: 0,
  aday: 1,
  izlemede: 2,
  elendi: 3,
};

export interface ChannelInput {
  channelId: string;
  name: string;
  handle: string | null;
  subs: number | null;
  country: string | null;
  joinedAt: number | null;
  /** Yakalanma kaydındaki kanal yaşı (gün) — `joinedAt` yoksa yedek. */
  channelAgeDaysAtCatch: number | null;
  caughtAt: number;
  snapshotFetchedAt: number | null;
  uploads: RawVideoCard[];
  seedQuery: string | null;
}

export interface UploadNow {
  videoId: string;
  title: string;
  views: number;
  ageDays: number;
  durationMin: number | null;
  thumbnailUrl: string | null;
}

export interface ChannelRow {
  channelId: string;
  name: string;
  link: string;
  status: Status;
  reason: string;
  flags: string[];
  language: string;
  ageDays: number | null;
  subs: number | null;
  country: string | null;
  longCount: number;
  uploads30: number;
  medianRecent: number | null;
  momentum: number | null;
  bursts: number;
  medianDurationMin: number | null;
  durationFit: '' | 'tam' | 'orta' | 'düşük';
  best: UploadNow | null;
  latestTitles: string[];
  classification: Classification | null;
  /** Görsel tavanı uygulanmış üretilebilirlik. */
  producibility: number | null;
  /** üretilebilirlik + formül + süre puanı (0–12); puansızsa null. */
  priority: number | null;
  seedQuery: string | null;
  caughtAt: number;
}

export function durationFit(minutes: number | null): {
  label: ChannelRow['durationFit'];
  score: number;
} {
  if (minutes === null) return { label: '', score: 0 };
  if (minutes >= OUR_DURATION_MIN && minutes <= OUR_DURATION_MAX) return { label: 'tam', score: 2 };
  if (
    (minutes >= 10 && minutes < OUR_DURATION_MIN) ||
    (minutes > OUR_DURATION_MAX && minutes <= 60)
  )
    return { label: 'orta', score: 1 };
  return { label: 'düşük', score: 0 };
}

/** Anlık görüntüdeki yüklemeleri bugüne taşır; Shorts/canlı ve izlenmesi okunamayan atılır. */
export function uploadsNow(input: ChannelInput, now: number): UploadNow[] {
  const elapsed = Math.max(0, (now - (input.snapshotFetchedAt ?? input.caughtAt)) / DAY);
  return input.uploads
    .filter(
      (u) =>
        u.kind === 'video' &&
        typeof u.viewsApprox === 'number' &&
        typeof u.publishedAgeDays === 'number',
    )
    .map((u) => ({
      videoId: u.videoId,
      title: u.title,
      views: u.viewsApprox as number,
      ageDays: (u.publishedAgeDays as number) + elapsed,
      durationMin: typeof u.durationSec === 'number' ? u.durationSec / 60 : null,
      thumbnailUrl: u.thumbnailUrl,
    }))
    .sort((a, b) => a.ageDays - b.ageDays);
}

function share(titles: readonly string[], test: (title: string) => boolean): number {
  if (titles.length === 0) return 0;
  return titles.filter(test).length / titles.length;
}

/** Başlıkların çoğunluk dili; ayırt edilemezse "?". */
export function majorityLanguage(titles: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const lang = detectLanguage(title);
    if (lang !== null) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (top === undefined) return '?';
  const second = ranked[1];
  // Belirgin çoğunluk yoksa karışık — dublajlı/çok dilli kanallar.
  if (second !== undefined && second[1] * 2 > top[1]) return 'karışık';
  return top[0].toUpperCase();
}

/** En sık geçen yasak terim, başlıkların yeterli payında geçiyorsa. */
export function bannedTerm(name: string, titles: readonly string[]): string | null {
  const nameHit = checkTopic(name, null, [], OUR_EXCLUDE_TERMS).excludedTerm;
  if (nameHit !== null) return nameHit;
  const counts = new Map<string, number>();
  for (const title of titles) {
    const term = checkTopic(title, null, [], OUR_EXCLUDE_TERMS).excludedTerm;
    if (term !== null) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (titles.length === 0 || total / titles.length < BANNED_TITLE_SHARE) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function evaluateChannel(
  input: ChannelInput,
  classification: Classification | undefined,
  now: number,
): ChannelRow {
  const all = uploadsNow(input, now);
  const long = all.filter((u) => u.durationMin !== null && u.durationMin * 60 >= LONG_VIDEO_SEC);
  const mature = long.filter((u) => u.ageDays >= MIN_VIDEO_AGE_DAYS);
  const recent = mature.slice(0, RECENT_N);
  const medianRecent = median(recent.map((u) => u.views));

  const elapsed = Math.max(0, (now - (input.snapshotFetchedAt ?? input.caughtAt)) / DAY);
  const uploads30 = all.filter((u) => u.ageDays - elapsed <= 30).length;

  let momentum: number | null = null;
  if (mature.length >= MOMENTUM_N * 2) {
    const newer = median(mature.slice(0, MOMENTUM_N).map((u) => u.views));
    const older = median(mature.slice(MOMENTUM_N, MOMENTUM_N * 2).map((u) => u.views));
    if (newer !== null && older !== null && older > 0) momentum = newer / older;
  }
  const best = [...long].sort((a, b) => b.views - a.views)[0] ?? null;
  const bursts =
    medianRecent === null ? 0 : recent.filter((u) => u.views >= medianRecent * BURST_FACTOR).length;
  const medianDurationMin = median(
    long.map((u) => u.durationMin).filter((m): m is number => m !== null),
  );
  const fit = durationFit(medianDurationMin === null ? null : Math.round(medianDurationMin));

  const titles = (long.length > 0 ? long : all).slice(0, 15).map((u) => u.title);
  const language = majorityLanguage(titles);

  let ageDays: number | null = null;
  if (input.joinedAt !== null) ageDays = (now - input.joinedAt) / DAY;
  else if (input.channelAgeDaysAtCatch !== null)
    ageDays = input.channelAgeDaysAtCatch + (now - input.caughtAt) / DAY;

  // İşaretler bilgi; durumu ancak aşağıdaki kurallar değiştirir.
  const flags: string[] = [];
  const fading = momentum !== null && momentum < FADING_RATIO;
  if (fading) flags.push('sönüyor');
  const recent5 = median(mature.slice(0, MOMENTUM_N).map((u) => u.views));
  const oneHit =
    best !== null &&
    medianRecent !== null &&
    recent5 !== null &&
    best.views >= medianRecent * ONE_HIT_BEST_FACTOR &&
    recent5 < best.views * ONE_HIT_RECENT_RATIO;
  if (oneHit) flags.push('tek vuruş');
  if (bursts > 0) flags.push(`${bursts} patlama`);
  if (momentum !== null && momentum >= 2) flags.push('ivmeli');

  const cap =
    classification?.gorsel_tipi === undefined ? 5 : PRODUCIBILITY_CAP[classification.gorsel_tipi];
  const producibility =
    classification === undefined ? null : Math.min(classification.uretilebilirlik, cap);
  const priority =
    classification === undefined || producibility === null
      ? null
      : producibility + classification.formul_benzerligi + fit.score;

  let status: Status = 'aday';
  let reason = '';
  const banned = bannedTerm(input.name, titles);
  const isIndic =
    INDIC_PATTERN.test(`${input.name} ${titles.join(' ')}`) ||
    INDIC_WORDS.test(`${input.name} ${titles.join(' ')}`);

  if (OWN_CHANNEL_IDS.includes(input.channelId)) {
    status = 'referans';
    reason = 'bizim kanal';
  } else if (isIndic) {
    status = 'elendi';
    reason = 'Hint içeriği';
  } else if (banned !== null) {
    status = 'elendi';
    reason = `yasak tür: ${banned}`;
  } else if (share(titles, (t) => SLEEP_PATTERN.test(t)) >= BANNED_TITLE_SHARE) {
    status = 'elendi';
    reason = 'uyku formatı';
  } else if (classification?.politika_riski === true) {
    status = 'elendi';
    reason = 'politika riski';
  } else if (ageDays !== null && ageDays > OUR_MAX_CHANNEL_AGE_DAYS) {
    status = 'elendi';
    reason = `kanal ${Math.round(ageDays)} günlük (> ${OUR_MAX_CHANNEL_AGE_DAYS})`;
  } else if (classification !== undefined && ELIMINATED_CATEGORIES.has(classification.kategori)) {
    status = 'elendi';
    reason = `kategori: ${classification.kategori}`;
  } else if (producibility !== null && producibility < MIN_PRODUCIBILITY) {
    status = 'elendi';
    reason =
      classification?.gorsel_tipi !== undefined && cap < (classification?.uretilebilirlik ?? 0)
        ? `üretilemez: ${classification.gorsel_tipi}`
        : `üretilemez (${producibility}/5)`;
  } else {
    const watch: string[] = [];
    if (long.length < MIN_LONG_VIDEOS)
      watch.push(`${long.length} uzun video (< ${MIN_LONG_VIDEOS})`);
    if (uploads30 < MIN_UPLOADS_30D) watch.push(`30 günde ${uploads30} yükleme`);
    if (medianRecent !== null && medianRecent < OUR_MIN_MEDIAN_VIEWS)
      watch.push(
        `medyan ${Math.round(medianRecent / 1000)} B (< ${OUR_MIN_MEDIAN_VIEWS / 1000} B)`,
      );
    if (medianRecent === null) watch.push('medyan ölçülemedi');
    if (fading) watch.push('sönüyor');
    if (oneHit) watch.push('tek vuruş');
    if (watch.length > 0) {
      status = 'izlemede';
      reason = watch.join(', ');
    }
  }

  return {
    channelId: input.channelId,
    name: input.name,
    link: `https://www.youtube.com/channel/${input.channelId}`,
    status,
    reason,
    flags,
    language,
    ageDays,
    subs: input.subs,
    country: input.country,
    longCount: long.length,
    uploads30,
    medianRecent,
    momentum,
    bursts,
    medianDurationMin,
    durationFit: fit.label,
    best,
    latestTitles: titles,
    classification: classification ?? null,
    producibility,
    priority,
    seedQuery: input.seedQuery,
    caughtAt: input.caughtAt,
  };
}

/**
 * Sıralama: durum → öncelik (puanlıysa) → medyan.
 * Aynı alt nişte kaç aday/izlemede kanal olduğu `crowding` ile döner — "kopya
 * sürüsü" dersi: ucuz formatlar haftalar içinde doluyor.
 */
export function sortRows(rows: ChannelRow[]): ChannelRow[] {
  return [...rows].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.priority ?? -1) - (a.priority ?? -1) ||
      (b.medianRecent ?? 0) - (a.medianRecent ?? 0),
  );
}

export function crowding(rows: readonly ChannelRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const niche = row.classification?.alt_nis?.trim().toLocaleLowerCase('tr');
    if (niche === undefined || niche === '') continue;
    if (row.status !== 'aday' && row.status !== 'izlemede') continue;
    counts.set(niche, (counts.get(niche) ?? 0) + 1);
  }
  return counts;
}

/** Claude'un sınıflaması için girdi satırı. */
export function classificationInput(row: ChannelRow) {
  return {
    id: row.channelId,
    ad: row.name,
    durum: row.status,
    dil: row.language,
    yas_gun: row.ageDays === null ? null : Math.round(row.ageDays),
    abone: row.subs,
    son10_medyan: row.medianRecent,
    ort_sure_dk: row.medianDurationMin === null ? null : Math.round(row.medianDurationMin),
    en_iyi:
      row.best === null
        ? null
        : { baslik: row.best.title, izlenme: row.best.views, id: row.best.videoId },
    basliklar: row.latestTitles,
  };
}
