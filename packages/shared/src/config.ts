import { z } from 'zod';

/**
 * Dile göre varsayılan tohum terimleri.
 *
 * Neden dile göre: tohum, taramanın İLK videosunu belirliyor. Yürüyüş dili
 * Türkçeyken sabit İngilizce tohum kullanmak, taramayı daha ilk adımda
 * filtrenin dışında bir yerden başlatır ve motor oradan Türkçeye geçmek için
 * boşuna dolaşır.
 *
 * Konular kasten geniş ve gündelik: dar bir tohum, grafın küçük bir köşesine
 * hapsolmak demek.
 */
const SEED_QUERIES: Record<string, readonly string[]> = {
  en: [
    'documentary',
    'how it works',
    'cooking recipe',
    'travel vlog',
    'science explained',
    'diy project',
    'history story',
    'tech review',
    'nature',
  ],
  tr: [
    'belgesel',
    'nasıl yapılır',
    'yemek tarifi',
    'gezi vlog',
    'bilim',
    'kendin yap',
    'tarih',
    'teknoloji inceleme',
    'doğa',
  ],
  de: [
    'dokumentation',
    'wie funktioniert',
    'rezept',
    'reise vlog',
    'wissenschaft erklärt',
    'selber machen',
    'geschichte',
    'technik test',
    'natur',
  ],
  fr: ['documentaire', 'recette cuisine', 'voyage vlog', 'science expliquée', 'histoire', 'nature'],
  es: [
    'documental',
    'receta de cocina',
    'viaje vlog',
    'ciencia explicada',
    'historia',
    'naturaleza',
  ],
  it: ['documentario', 'ricetta', 'viaggio vlog', 'scienza', 'storia', 'natura'],
  pt: ['documentário', 'receita', 'viagem vlog', 'ciência', 'história', 'natureza'],
  ru: ['документальный фильм', 'рецепт', 'путешествие влог', 'наука', 'история', 'природа'],
  ar: ['وثائقي', 'وصفة طبخ', 'رحلة', 'علوم', 'تاريخ', 'طبيعة'],
  ja: ['ドキュメンタリー', 'レシピ', '旅行 vlog', '科学', '歴史', '自然'],
  ko: ['다큐멘터리', '레시피', '여행 브이로그', '과학', '역사', '자연'],
  zh: ['纪录片', '食谱', '旅行 vlog', '科学', '历史', '自然'],
  hi: ['वृत्तचित्र', 'रेसिपी', 'यात्रा व्लॉग', 'विज्ञान', 'इतिहास', 'प्रकृति'],
};

/** Bilinmeyen dil için İngilizceye düşer — uydurma terim üretilmez. */
export function defaultSeedQueries(language: string | null | undefined): string[] {
  const key = typeof language === 'string' ? language.toLowerCase() : 'en';
  return [...(SEED_QUERIES[key] ?? SEED_QUERIES.en ?? [])];
}

const TopicTermsSchema = z
  .array(z.string().trim().min(2).max(80))
  .max(30)
  .transform((terms) => [...new Set(terms.map((term) => term.trim()).filter(Boolean))]);

/**
 * Tarama yapılandırması. Varsayılanlar araştırma bulgularından:
 * sektör pratikleri (1of10/Apify/Outlier Finder) + yt-dlp misafir limitleri.
 * UI eşiği 5.0x gösterir; tarayıcı crawlThreshold=3.0x'te kaydeder ki
 * sonradan eşiği düşürmek yeni tarama gerektirmesin.
 */
export const CrawlConfigSchema = z
  .object({
    /**
     * AV MODU — ne aradığımız.
     *
     * `video`: bir videonun, KENDİ kanalının medyanının kaç katını aldığı.
     * `channel`: kısa sürede açılmış ve neredeyse her videosu tutan KANALLAR.
     *
     * İkisi ayrı mod olmak zorunda, çünkü video modu kanal modunun aradığı şeyi
     * yapısal olarak göremiyor: her videosu tutan bir kanalın medyanı zaten
     * yüksektir, dolayısıyla hiçbir videosu kendi normalinin katına çıkmaz ve
     * kanal 1–2x skorlarla elenir. Yani bu bir eşik meselesi değil, farklı bir
     * kabul birimi (video yerine kanal) meselesi.
     */
    mode: z.enum(['video', 'channel']).default('video'),

    /** Sonucun ait olması gereken niş. Boşsa konu kapısı uygulanmaz. */
    topicIncludeTerms: TopicTermsSchema.default([]),
    /** Bu terimlerden biri başlık/kanalda geçerse dal anında kapanır. */
    topicExcludeTerms: TopicTermsSchema.default([]),
    /** Eşleşmeyen öneriler üzerinden kaç köprü adımı yürünebileceği. */
    topicStrictness: z.enum(['strict', 'balanced', 'explore']).default('balanced'),

    /*
     * KANAL MODUNUN İKİ KAPISI. Başka kapı yok — mod bilinçli olarak iki
     * soruya indirgendi: kanal ne kadar yeni, videoları ne kadar izleniyor.
     */
    /** Kanal bundan yaşlıysa aranan "yeni kanal" değildir. */
    maxChannelAgeDays: z.number().int().min(7).max(3650).default(180),
    /**
     * Kanalın MEDYAN izlenmesi bundan az olmamalı.
     *
     * Medyan, maksimum değil: tek videosu patlamış bir kanal maksimumla geçerdi
     * ama medyanla geçemez. Yani "istikrarlı biçimde çok izleniyor" fikri, ayrı
     * bir istikrar eşiğine gerek kalmadan bu tek sayının içinde duruyor.
     */
    minChannelMedianViews: z.number().int().min(0).default(10_000),
    /**
     * İstatistiğin anlamlı olması için gereken en az yükleme.
     *
     * Kapı değil, ölçüm zemini: iki videosu olan bir kanalın "medyanı" hakkında
     * konuşmak yanıltıcı olur.
     */
    minChannelUploads: z.number().int().min(2).max(30).default(4),
    /** Kanal modu: kuruluş tarihi okunamayan kanallar kabul edilsin mi? */
    allowUnknownChannelAge: z.boolean().default(false),

    /**
     * Üst sınır 10: dil filtresi açıkken derin zincirler ARANAN şey oluyor.
     * Filtresiz taramada derinlik bir yankı fanusu riskiydi; dil filtresiyle
     * birlikte fanusun kendisi hedef — o dilin alt-grafında kalmak istiyoruz.
     */
    maxDepth: z.number().int().min(2).max(10).default(4),
    maxVideosScanned: z.number().int().min(50).max(20_000).default(1000),
    channelRequestBudget: z.number().int().min(10).max(2000).default(300),
    requestBudget: z.number().int().min(100).max(10_000).default(1500),

    /**
     * Sınırlar KAPATILABİLİR: `null` = o yönde sınır yok.
     *
     * İkisi birden null ise abone sayısı hiç filtrelenmez — kullanıcı bazen
     * "kanal boyutu ne olursa olsun, sadece çarpanı yüksek olanları göster"
     * demek ister.
     */
    minSubs: z.number().int().min(0).max(10_000_000).nullable().default(1000),
    maxSubs: z.number().int().min(100).max(50_000_000).nullable().default(50_000),

    hypeThreshold: z.number().min(2).max(25).default(5.0),
    crawlThreshold: z.number().min(1).max(25).default(3.0),
    vsrThreshold: z.number().min(1).max(25).default(3.0),

    maxVideoAgeDays: z.number().min(1).max(3650).nullable().default(30),
    minVideoAgeHours: z.number().min(0).max(168).nullable().default(18),
    minViews: z.number().int().min(0).nullable().default(10_000),
    /**
     * İzlenme tavanı — kanal isteği bütçesinin en önemli ücretsiz koruması.
     *
     * Canlı testte ortaya çıktı: öneri grafı sürekli dev kanalları önerdiği için
     * taranan 60 videonun 18'i pahalı kanal isteği harcadı ve HEPSİ aralık dışı
     * çıktı. Bir kanalın abone sayısını sormadan bilemeyiz, ama videonun kendi
     * izlenmesi bedava bir vekil: 1k–50k aboneli bir kanalın videosunun 2 milyonu
     * aşması, 100 katı aşan bir çarpan demek — gerçekçi aralığın çok ötesinde.
     */
    maxViews: z.number().int().min(1000).nullable().default(2_000_000),
    minVpd: z.number().min(0).nullable().default(500),

    epsilon: z.number().min(0).max(1).default(0.2),
    paceMinMs: z.number().int().min(500).max(30_000).default(1200),
    paceMaxMs: z.number().int().min(500).max(60_000).default(3200),

    baselineSize: z.number().int().min(3).max(30).default(12),
    baselineLookbackDays: z.number().int().min(30).max(3650).default(365),
    baselineFloor: z.number().min(1).default(400),
    baselineMinN: z.number().int().min(2).max(20).default(5),

    /**
     * TARAMA BÖLGESİ — hangi ülkenin algoritmasına soruyoruz. ISO-3166-1 alpha-2.
     *
     * `countries` ile KARIŞTIRILMAMALI, ikisi farklı sorulara cevap veriyor:
     *   region    = YouTube'a hangi ülkedeymişiz gibi görünüyoruz (İLK istekten
     *               itibaren; öneri ve arama sonuçlarını o bölgeye kaydırır)
     *   countries = sonuçta hangi ülkenin kanallarını kabul ediyoruz (en son kapı)
     * "TR algoritması ama global kanallar" meşru bir kombinasyon.
     *
     * ÖLÇÜLDÜ (`@hype/innertube` `tools/region-probe.ts`, 8 Ağu 2026) ve etkisi
     * SINIRLI çıktı — abartılmamalı:
     *   • Bölge beyanı YouTube'un IP tabanlı çıkarımını geçersiz kılıyor (kesin).
     *   • Arama sonuçlarını 4 sorgudan 1'inde gürültünün ötesinde değiştiriyor.
     *   • Öneri grafını kaydırmıyor: her kol kendi ülkesinin kanallarını
     *     yalnızca ~5 puan öne çıkarıyor (kabul eşiği 15 puandı).
     * Ölçüm TAZE kimliklerle yapıldı, yani zayıf sonuç birikmiş kişiselleştirme
     * yüzünden değil. İçerik bölgesini pratikte hâlâ `seedQueries`'in dili
     * belirliyor; gerçek coğrafi yönlendirme için IP değiştirmek gerekir.
     *
     * `null` = bugüne kadarki davranış (US). DİL alanı BİLEREK YOK: `hl`
     * değiştirilemez, çünkü `@hype/innertube`'un metin ayrıştırıcıları
     * İngilizceye çivili ("3 days ago", "12.3K subscribers") ve `hl` değişirse
     * hepsi sessizce bozulur. İçeriğin dili tohum terimleriyle seçilir.
     */
    region: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'İki harfli ülke kodu bekleniyor (örn. TR, DE)')
      .nullable()
      .default(null),

    /**
     * Yalnızca bu ülkelerdeki kanallar. null / boş = ülke filtresi yok.
     *
     * Bilerek en sona konan filtre: ülke bilgisi ayrı bir istek gerektiriyor,
     * bu yüzden ancak abone aralığını ve skor eşiğini geçmiş adaylar için
     * sorulur. Sonuç kalıcı önbelleğe girer — bir kanalın ülkesi değişmez.
     */
    countries: z.array(z.string().min(2).max(60)).max(20).nullable().default(null),
    /** Ülkesini beyan etmemiş kanallar da kabul edilsin mi? */
    allowUnknownCountry: z.boolean().default(false),

    /**
     * YÜRÜYÜŞ DİLİ — öneri grafında hangi kenardan yürüyeceğimiz.
     *
     * Bölge beyanının öneri grafını kaydırmadığını ölçtük (bkz. `region`). Ama
     * hangi komşuya "tıkladığımız" tamamen bizim elimizde: Türkçe bir videonun
     * komşuları zaten Türkçedir, yalnızca o kenarlardan yürürsek tarama
     * kendiliğinden o dilin alt-grafına yerleşir ve derinlik arttıkça saflaşır.
     * Mekanizma "algoritmanın öğrenmesi" değil, grafın kendi yapısı.
     *
     * Başlık zaten kartta olduğu için bu filtre BEDAVA — kanal isteği harcamaz.
     *
     * Yalnızca YÜRÜMEYİ engeller, ELEMEZ: dil tutmayan bir video yolda
     * bulunduysa havuza girebilir. Sıkı davranmak için `countries` var.
     */
    crawlLanguages: z.array(z.string().min(2).max(5)).max(5).nullable().default(null),
    /** Dili ayırt edilemeyen videoların üstünden yürünsün mü? */
    allowUnknownLanguage: z.boolean().default(true),

    enrichOnExport: z.boolean().default(true),

    /**
     * Tohum arama terimleri.
     *
     * Anonim oturumda YouTube ana sayfası video yerine "giriş yap" kartı
     * döndürüyor (canlı testte doğrulandı), bu yüzden asıl tohum kaynağı arama.
     * Bu liste taramanın DİLİNİ ve KONUSUNU belirler.
     *
     * BOŞ bırakılırsa aşağıdaki `transform` yürüyüş diline (yoksa bölgeye)
     * uygun varsayılanları koyuyor. Eskiden burada sabit İngilizce bir liste
     * vardı ve Türkçe filtreyle birlikte ilk video İngilizce çıkıyordu — yani
     * tarama daha ilk adımda filtrenin dışında bir yerden başlıyordu.
     */
    seedQueries: z.array(z.string().min(1).max(100)).max(50).default([]),
  })
  /*
   * Boş tohum listesi, taramanın DİLİNE göre doldurulur. Kullanıcı özel
   * tohumlar yazmış ama hedef terimleri boş bırakmışsa aynı terimler konu
   * kapısına da aktarılır; varsayılan geniş taramada konu kapısı açılmaz.
   *
   * Transform refine'lardan ÖNCE: aşağıdaki kurallar dolu bir liste görmeli.
   */
  .transform((c) => {
    const language = c.crawlLanguages?.[0] ?? languageForRegion(c.region) ?? 'en';
    const defaults = defaultSeedQueries(language);
    if (c.seedQueries.length > 0) {
      const generatedDefaults =
        c.seedQueries.length === defaults.length &&
        c.seedQueries.every((query, index) => query === defaults[index]);
      return {
        ...c,
        topicIncludeTerms:
          c.topicIncludeTerms.length > 0 || generatedDefaults
            ? c.topicIncludeTerms
            : [...c.seedQueries],
      };
    }
    return { ...c, seedQueries: defaults };
  })
  // Karşılaştırmalar yalnızca iki uç da açıkken yapılır; kapalı bir sınır
  // hiçbir zaman "geçersiz" olamaz.
  .refine((c) => c.minViews === null || c.maxViews === null || c.minViews < c.maxViews, {
    message: 'Min izlenme, maks izlenmeden küçük olmalı',
    path: ['minViews'],
  })
  .refine((c) => c.minSubs === null || c.maxSubs === null || c.minSubs < c.maxSubs, {
    message: 'Min abone, maks aboneden küçük olmalı',
    path: ['minSubs'],
  })
  .refine((c) => c.paceMinMs <= c.paceMaxMs, {
    message: 'paceMinMs, paceMaxMs değerini aşamaz',
    path: ['paceMinMs'],
  })
  .refine((c) => c.crawlThreshold <= c.hypeThreshold, {
    message:
      'crawlThreshold, hypeThreshold değerini aşamaz (kayıt eşiği görüntüleme eşiğinden gevşek olmalı)',
    path: ['crawlThreshold'],
  })
  .refine(
    (c) =>
      c.minVideoAgeHours === null ||
      c.maxVideoAgeDays === null ||
      c.minVideoAgeHours / 24 < c.maxVideoAgeDays,
    {
      message: 'Min yaş, maks yaş penceresinin içinde kalmalı',
      path: ['minVideoAgeHours'],
    },
  );

export type CrawlConfig = z.infer<typeof CrawlConfigSchema>;
export type CrawlConfigInput = z.input<typeof CrawlConfigSchema>;

export const DEFAULT_CRAWL_CONFIG: CrawlConfig = CrawlConfigSchema.parse({});

export interface BuiltinPreset {
  name: string;
  /** Ayarın ne işe yaradığı — arayüzde seçilince gösterilir. */
  description: string;
  config: CrawlConfigInput;
}

/**
 * Arayüzde hazır gelen ayarlar.
 *
 * Hiçbirini seçmek zorunlu değil: form zaten varsayılanlarla dolu gelir ve
 * doğrudan Başlat'a basmak çalışır. Presetler yalnızca sık kullanılan
 * kombinasyonlara kısayol.
 */
/**
 * Arayüzün sunduğu tarama bölgeleri.
 *
 * Burada, `@hype/innertube`'da değil: web paketi yalnızca shared'ı import
 * edebiliyor. Adaptör tarafındaki zaman dilimi eşlemesi ayrı bir tablo ve
 * burada olmayan bir kod orada UTC'ye düşüyor — yani listeler ayrışsa bile
 * davranış güvenli kalıyor.
 *
 * `region` alanı serbest metin DEĞİL, iki harfli kodla doğrulanıyor; bu liste
 * yalnızca "hangi ülkeleri öneriyoruz" sorusuna cevap.
 */
export const REGIONS: readonly { code: string; label: string; lang: string | null }[] = [
  { code: 'TR', label: 'Türkiye', lang: 'tr' },
  { code: 'US', label: 'Amerika Birleşik Devletleri', lang: 'en' },
  { code: 'GB', label: 'Birleşik Krallık', lang: 'en' },
  { code: 'DE', label: 'Almanya', lang: 'de' },
  { code: 'FR', label: 'Fransa', lang: 'fr' },
  // Hollandaca henüz algılanamıyor; dil önerisi uydurulmuyor.
  { code: 'NL', label: 'Hollanda', lang: null },
  { code: 'ES', label: 'İspanya', lang: 'es' },
  { code: 'IT', label: 'İtalya', lang: 'it' },
  { code: 'RU', label: 'Rusya', lang: 'ru' },
  { code: 'IN', label: 'Hindistan', lang: 'hi' },
  { code: 'JP', label: 'Japonya', lang: 'ja' },
  { code: 'KR', label: 'Güney Kore', lang: 'ko' },
  { code: 'ID', label: 'Endonezya', lang: null },
  { code: 'SA', label: 'Suudi Arabistan', lang: 'ar' },
  { code: 'AE', label: 'Birleşik Arap Emirlikleri', lang: 'ar' },
  { code: 'EG', label: 'Mısır', lang: 'ar' },
  { code: 'BR', label: 'Brezilya', lang: 'pt' },
  { code: 'MX', label: 'Meksika', lang: 'es' },
  { code: 'AR', label: 'Arjantin', lang: 'es' },
  { code: 'CA', label: 'Kanada', lang: 'en' },
  { code: 'AU', label: 'Avustralya', lang: 'en' },
];

/**
 * Yürüyüş dili olarak seçilebilen diller — algılayıcının GERÇEKTEN ayırt
 * edebildikleri (`@hype/core` `pipeline/language.ts`). Liste kasten kısa:
 * ayırt edemediğimiz bir dili sunmak, kullanıcıya çalışmayan bir filtre vaat
 * etmek olurdu.
 */
export const CRAWL_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: 'tr', label: 'Türkçe' },
  { code: 'en', label: 'İngilizce' },
  { code: 'de', label: 'Almanca' },
  { code: 'fr', label: 'Fransızca' },
  { code: 'es', label: 'İspanyolca' },
  { code: 'it', label: 'İtalyanca' },
  { code: 'pt', label: 'Portekizce' },
  { code: 'ru', label: 'Rusça' },
  { code: 'ar', label: 'Arapça' },
  { code: 'ja', label: 'Japonca' },
  { code: 'ko', label: 'Korece' },
  { code: 'zh', label: 'Çince' },
  { code: 'hi', label: 'Hintçe' },
];

/** Bölgenin baskın içerik dili; algılayamadığımız diller için `null`. */
export function languageForRegion(region: string | null | undefined): string | null {
  if (typeof region !== 'string') return null;
  const upper = region.toUpperCase();
  return REGIONS.find((r) => r.code === upper)?.lang ?? null;
}

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  {
    name: 'Yükselen kanallar',
    description:
      'Video değil KANAL avı: yakın zamanda açılmış ve videoları istikrarlı biçimde çok izlenen kanallar. Video modunun göremediği tek şey bu — her videosu tutan kanalın medyanı zaten yüksektir, hiçbir videosu sivrilmez.',
    config: {
      mode: 'channel',
      /*
       * Abone aralığı KAPALI. Yükselen bir kanalın abone sayısı herhangi bir
       * şey olabilir; zaten aranan şey "az aboneyle çok izlenme". Bu filtreyi
       * açık bırakmak hedefle çatışırdı ve istek de tasarruf etmiyor — abone
       * sayısı ancak kanal isteği atıldıktan sonra öğreniliyor.
       * 1M üstü kalıcı kara liste yine devrede.
       */
      minSubs: null,
      maxSubs: null,
      // Yürüyüş filtresi: grafın taze bölgesinde kalmak taramayı hızlandırıyor.
      maxVideoAgeDays: 60,
    },
  },
  {
    name: 'Küçük kanallar (1B–10B abone)',
    description:
      'En dar av alanı. Yeni başlayan kanalların patlayan videolarını arar; bulması en zor ama en "keşif" hissi veren ayar.',
    config: { minSubs: 1000, maxSubs: 10_000, minViews: 5000 },
  },
  {
    name: 'Dengeli (1B–50B abone)',
    description:
      'Varsayılan. Küçük ama tamamen yeni olmayan kanallar; hem yeterince sonuç bulur hem de dev kanallara boğulmaz.',
    config: {},
  },
  {
    name: 'Büyüyen kanallar (10B–250B abone)',
    description:
      'Oturmuş ama hâlâ küçük sayılan kanallar. Daha çok sonuç verir, çarpanlar genelde daha düşüktür.',
    config: { minSubs: 10_000, maxSubs: 250_000, minViews: 25_000 },
  },
  {
    name: 'Türkçe içerik',
    description:
      'Dengeli ayarın Türkçe hâli. İçeriği asıl belirleyen tohum terimlerinin dili; bölge beyanı ek bir sinyal.',
    config: {
      // Preset artık iki kaldıracı birlikte kuruyor: tohum dili İÇERİĞİ,
      // bölge ise ALGORİTMAYI Türkiye'ye çekiyor.
      region: 'TR',
      seedQueries: [
        'belgesel',
        'yemek tarifi',
        'köy hayatı',
        'gezi vlog',
        'tarih',
        'nasıl yapılır',
        'doğa',
        'teknoloji inceleme',
        'kısa film',
      ],
    },
  },
] as const;
