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
 * Tarama tohumları — bizim açık niş yönlerimiz (1 Kas sıralaması ve sonrası).
 *
 * Kasıtlı olarak FORMAT + KONU birlikte: "iceberg" tek başına karanlık
 * kanallara götürüyor, "ocean iceberg" temiz kola. Yasak terimler aynı
 * taramada ayrıca uygulanıyor.
 */
export const OUR_SEED_QUERIES: Record<string, readonly string[]> = {
  en: [
    'ocean iceberg explained',
    'space iceberg explained',
    'lost places iceberg',
    'every type of machine explained',
    'every engine type explained',
    'how ancient people solved',
    'ancient technology explained',
    'ancient engineering documentary',
    'what if earth',
    'what if scenario explained',
    'natural phenomenon explained',
    'science of natural disasters',
    'deep sea documentary',
    'geography explained maps',
    'why countries are shaped',
    'history of everyday objects',
    'how it was made history',
    'prehistoric earth documentary',
    'megaprojects explained',
    'strange places on earth',
  ],
  es: [
    'iceberg del océano',
    'iceberg del espacio',
    'qué pasaría si la tierra',
    'fenómenos naturales explicados',
    'ciencia de los desastres naturales',
    'tecnología antigua explicada',
    'cómo resolvían los antiguos',
    'todos los tipos de máquinas',
    'lugares más extraños del planeta',
    'documental del fondo del mar',
    'historia de la tierra documental',
    'geografía explicada',
  ],
  de: [
    'eisberg ozean erklärt',
    'eisberg weltraum',
    'versunkene orte',
    'was wäre wenn die erde',
    'naturphänomene erklärt',
    'antike technik erklärt',
    'wie lebten menschen früher',
    'tiefsee dokumentation',
    'geographie erklärt',
    'jede art von maschine erklärt',
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
