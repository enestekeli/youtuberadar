/**
 * BİZİM SİSTEM — radarın aradığı kanalın tanımı.
 *
 * Radar artık "herhangi bir yükselen kanal"ı değil, bizim üretim hattımızla
 * (yt-pipeline: senaryo → AI sabit görsel / kodla render → ElevenLabs anlatım →
 * CapCut montaj, 20–35 dk yatay video) kopyalanabilecek kanalı arıyor. Kurallar
 * Claude hafızasındaki kanal genişleme planından (2026-10-15 … 2026-11-03):
 *
 *   • Yeni kanal yapay zekâ VİDEOSU kullanmaz. Kabul: AI sabit görsel, gerçek /
 *     stok görüntü + render (harita, grafik, 3D), kodla 2D animasyon.
 *   • Evergreen ve geniş konu havuzu; güncel haber ağırlıklı kanallar tutmuyor.
 *   • "20 B'lik videolar için kanal kurdurma": medyanı 20 B altındaki kanal aday
 *     sayılmaz, izlemede kalır.
 *   • Uyku formatı, gerçek suç, korku/okült/komplo, çocuk, oyun, müzik, vlog,
 *     tepki, dizi/film, Hint içeriği elenir; taklit ve kehanet politika riski.
 *   • Ölçüm yalnız uzun videolardan (≥ 8 dk): Shorts ve kısa klipler medyanı
 *     şişirip bizim yapamayacağımız kanalları aday gösteriyordu.
 *
 * Bu dosya hem tarayıcının (tohum + yasak terim + varsayılan eşikler) hem de
 * `apps/server/tools/export-channels.mts`'nin (durum, görsel tavanı) tek
 * kaynağı. Kural değişirse burası değişir.
 */

/** Bizim kanallar — export'ta "referans" satırı olur, aday sayılmaz. */
export const OWN_CHANNELS: readonly { id: string; name: string }[] = [
  { id: 'UCGH1GXDCNTTHkhPiLBQ3sLw', name: 'Beneath The Verse' },
  { id: 'UCKssyQDdDL1R4eGxfz5ARVw', name: 'Bajo el Versículo' },
];
export const OWN_CHANNEL_IDS: readonly string[] = OWN_CHANNELS.map((c) => c.id);

/** Uzun video sınırı: medyan, ivme ve süre uyumu yalnız bunlardan ölçülür. */
export const LONG_VIDEO_SEC = 480;

/** Hattımızın rahat ürettiği süre aralığı (dk). */
export const OUR_DURATION_MIN = 20;
export const OUR_DURATION_MAX = 40;

/** Aday olmak için gereken en düşük uzun-video medyanı. */
export const OUR_MIN_MEDIAN_VIEWS = 20_000;

/** Kanal yaşı tavanı: bundan eski kanal "yeni kanal modeli" değildir. */
export const OUR_MAX_CHANNEL_AGE_DAYS = 180;

/**
 * Tarama tohumları — GENEL ağ (2026-11-05, kullanıcı: "bu pazar çok dar, bize
 * genel arama lazım; belirli niş için zaten ayrı arama betiği yazıyoruz").
 *
 * Radarın işi geniş ağ atmak: hattımızla yapılabilecek her FORMAT ve KONU
 * (belgesel, açıklama, tarih, bilim, gizem, liste, What If, iceberg, every
 * type…). Neyin bize uygun olduğunu tohum değil SÜZGEÇ belirliyor: uzun video,
 * genç kanal, 20 B medyan, yasak türler, sonra sınıflama. Tohum başına "bu ay
 * + en çok izlenen" araması yapılır (`searchFilter: 'views_month'`).
 *
 * Kurallar: tohum kendi yasak terimine takılmamalı (testte sabit), şema
 * sınırı dil başına 50.
 */
export const OUR_SEED_QUERIES: Record<string, readonly string[]> = {
  en: [
    'documentary',
    'full documentary',
    'explained',
    'history explained',
    'science explained',
    'animated documentary',
    'mystery explained',
    'unsolved mysteries',
    'iceberg explained',
    'what if',
    'every type of',
    'top 10 facts',
    'the real reason why',
    'the truth about',
    'how did they build',
    'how it works',
    'ancient history',
    'ancient civilizations',
    'medieval history',
    'military history',
    'empire rise and fall',
    'world war documentary',
    'space documentary',
    'universe explained',
    'ocean documentary',
    'nature documentary',
    'animal facts',
    'human body explained',
    'psychology explained',
    'economics explained',
    'business documentary',
    'company history',
    'engineering explained',
    'technology explained',
    'geography explained',
    'maps explained',
    'disaster documentary',
    'survival story',
    'strange places',
    'lost civilizations',
  ],
  es: [
    'documental',
    'documental completo',
    'explicado',
    'historia explicada',
    'ciencia explicada',
    'misterios sin resolver',
    'iceberg explicado',
    'qué pasaría si',
    'todos los tipos de',
    'datos curiosos',
    'la verdadera razón',
    'cómo funciona',
    'historia antigua',
    'civilizaciones antiguas',
    'historia medieval',
    'segunda guerra mundial documental',
    'imperios',
    'documental del espacio',
    'el universo explicado',
    'documental del océano',
    'documental de naturaleza',
    'cuerpo humano explicado',
    'psicología explicada',
    'economía explicada',
    'historia de empresas',
    'ingeniería explicada',
    'geografía explicada',
    'desastres documental',
    'lugares extraños',
  ],
  de: [
    'dokumentation',
    'doku deutsch',
    'erklärt',
    'geschichte erklärt',
    'wissenschaft erklärt',
    'ungelöste rätsel',
    'eisberg erklärt',
    'was wäre wenn',
    'jede art von',
    'fakten',
    'der wahre grund',
    'wie funktioniert',
    'antike geschichte',
    'mittelalter',
    'zweiter weltkrieg doku',
    'imperium aufstieg und fall',
    'weltraum doku',
    'ozean doku',
    'natur doku',
    'menschlicher körper erklärt',
    'psychologie erklärt',
    'wirtschaft erklärt',
    'firmengeschichte',
    'technik erklärt',
    'geographie erklärt',
    'katastrophen doku',
  ],
};

/**
 * Yasak terimler — eşleşen kartın üstünden yürünmez ve yakalanmaz.
 *
 * Eşleştirme `checkTopic` kurallarıyla: kelime başı + 5+ harfli kelimede son
 * harf gevşetmesi. Bu yüzden kısa ve çok anlamlı kelimeler ("drama", "scary",
 * "live") BİLEREK yok — "The Dramatic Fall of Rome"u elerdi. Çok kelimeli
 * terimlerde her parça başlıkta geçmeli.
 */
export const OUR_EXCLUDE_TERMS: readonly string[] = [
  // müzik / ses
  'music',
  'müzik',
  'musik',
  'música',
  'remix',
  'karaoke',
  'asmr',
  // uyku formatı (tutunma %6)
  'sleep',
  'for sleep',
  'bedtime',
  'para dormir',
  'einschlafen',
  // yüzlü / çekim ("reaction" yok: "chemical reaction"ı da elerdi)
  'vlog',
  'reacting to',
  'podcast',
  'interview',
  'q&a',
  'day in my life',
  'get ready with me',
  'prank',
  'unboxing',
  // oyun / anime / dizi-film ("anime" yok: kök "anim" animation/animal'ı elerdi)
  'gameplay',
  'minecraft',
  'roblox',
  'fortnite',
  'manhwa',
  'kdrama',
  'full episode',
  'full movie',
  'movie recap',
  'película completa',
  'resumen película',
  // gerçek suç / korku / okült / komplo ("murder"/"horror" yok: afet ve tarih
  // başlıklarında da geçiyor; o kanalları export'taki sınıflama eler)
  'true crime',
  'serial killer',
  'creepypasta',
  'paranormal',
  'conspiracy',
  'tarot',
  'horoscope',
  'astrology',
  // haber
  'news',
  'noticias',
  'nachrichten',
  // çocuk
  'nursery',
  'for kids',
  'para niños',
  'für kinder',
  // Hint pazarı (RPM düşük, hat yok). "hindi" yok: kök "hind" Hindenburg'u
  // elerdi; Devanagari başlıklar export'ta alfabeden yakalanıyor.
  'urdu',
];

/**
 * Görsel tipi — kanalın videolarını nasıl ürettiği (kare farkı ölçümü ya da
 * Claude'un incelemesi). Export'taki üretilebilirlik puanına TAVAN koyar.
 */
export const VISUAL_TYPES = [
  'sabit_gorsel',
  '2d_animasyon',
  'render',
  'stok_video',
  'karisik',
  'ai_video',
  'gercek_cekim',
] as const;
export type VisualType = (typeof VISUAL_TYPES)[number];

/**
 * Üretilebilirlik tavanı. AI video ve gerçek çekim bizim kuralımızla
 * yapılamaz (1 → otomatik elenir); karışık (bir kısmı AI klip) 3.
 */
export const PRODUCIBILITY_CAP: Record<VisualType, number> = {
  sabit_gorsel: 5,
  '2d_animasyon': 5,
  render: 5,
  stok_video: 4,
  karisik: 3,
  ai_video: 1,
  gercek_cekim: 1,
};

/** Sınıflama kategorileri. `ELIMINATED_CATEGORIES` otomatik elenir. */
export const CATEGORIES = [
  'anlatimli_belgesel',
  'dini_anlatim',
  'cocuk',
  'oyun',
  'kisa_dizi_drama',
  'vlog',
  'muzik',
  'haber',
  'tepki',
  'derleme',
  'gercek_cekim',
  'gercek_suc_korku',
  'uyku',
  'diger',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const ELIMINATED_CATEGORIES: ReadonlySet<string> = new Set<Category>([
  'cocuk',
  'oyun',
  'kisa_dizi_drama',
  'vlog',
  'muzik',
  'haber',
  'tepki',
  'derleme',
  'gercek_cekim',
  'gercek_suc_korku',
  'uyku',
  'diger',
]);

/** Üretilebilirlik bunun altındaysa hattımızla yapılamaz. */
export const MIN_PRODUCIBILITY = 2;

/** Uyku/arka plan formatı — başlıklarda geçerse kanal elenir. */
export const SLEEP_PATTERN =
  /\b(sleep|sleepy|asleep|bedtime|relaxing|fall asleep|for sleep|para dormir|dormir|zum einschlafen|einschlafen|uyku)\b/i;
