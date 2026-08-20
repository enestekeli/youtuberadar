/**
 * Başlık dilinin tespiti.
 *
 * Neden var: YouTube'un coğrafya inancını beyanla değiştiremediğimizi ölçtük
 * (`@hype/innertube` `tools/region-probe.ts`) — `gl` öneri grafını kaydırmıyor.
 * Ama grafta HANGİ KENARDAN yürüdüğümüz tamamen bizim elimizde. Türkçe bir
 * videonun komşuları zaten Türkçedir; yalnızca o kenarlardan yürürsek tarama
 * kendiliğinden o dilin alt-grafına yerleşir. Mekanizma "algoritmanın öğrenmesi"
 * değil, grafın kendi yapısı — bu yüzden de kırılgan değil.
 *
 * Girdi kısa ve gürültülü: video başlıkları 3–10 kelime, sık sık emoji, marka
 * adı ve İngilizce kırıntı taşıyor. O yüzden tek sinyale güvenilmiyor.
 *
 * EN ÖNEMLİ KURAL: emin değilse `null` döner, tahmin etmez. Bu, `text-parse.ts`
 * ile aynı ilke — okunamayan bir değer asla varsayılana kıvrılmaz, ayrı bir
 * durum olarak yukarı taşınır ve kararı çağıran verir.
 */

export type LanguageCode =
  | 'tr'
  | 'de'
  | 'en'
  | 'fr'
  | 'es'
  | 'it'
  | 'pt'
  | 'ru'
  | 'ar'
  | 'ja'
  | 'ko'
  | 'zh'
  | 'hi';

/**
 * Alfabesi tek başına belirleyici olan diller.
 *
 * Latin alfabesindeki dilleri ayırmak zor, ama Kiril/Arap/CJK için karakter
 * aralığı neredeyse kesin cevap. Bunları önce ve ucuz kontrol ediyoruz.
 */
const SCRIPTS: { code: LanguageCode; pattern: RegExp }[] = [
  { code: 'ru', pattern: /[Ѐ-ӿ]/ },
  { code: 'ar', pattern: /[؀-ۿ]/ },
  { code: 'hi', pattern: /[ऀ-ॿ]/ },
  { code: 'ko', pattern: /[가-힯ᄀ-ᇿ]/ },
  // Kana JAPONCAYA özel; Han (kanji) tek başına Çince ile karışır.
  { code: 'ja', pattern: /[぀-ゟ゠-ヿ]/ },
  { code: 'zh', pattern: /[一-鿿]/ },
];

/**
 * Latin alfabesindeki dillerin ayırt edici harfleri.
 *
 * `ı` (noktasız i) ve `ğ` pratikte Türkçeye özgü; `ß` Almancaya. Ama `ö/ü`
 * Türkçe ve Almancada ortak, `é` birçok dilde var — o yüzden bunlar tek başına
 * karar verdirmiyor, yalnızca PUAN ekliyor.
 */
const LETTERS: { code: LanguageCode; strong: RegExp; weak?: RegExp }[] = [
  { code: 'tr', strong: /[ığş]/, weak: /[çöü]/ },
  { code: 'de', strong: /[ß]/, weak: /[äöü]/ },
  { code: 'fr', strong: /[àâêëîïôùûœ]/, weak: /[éè]/ },
  { code: 'es', strong: /[ñ¡¿]/, weak: /[áíóú]/ },
  { code: 'it', strong: /[àèìòù]/ },
  { code: 'pt', strong: /[ãõ]/ },
];

/**
 * Durak kelimeler — kısa metinde en güvenilir sinyal.
 *
 * Sadece BAŞLIKLARDA gerçekten görülenler seçildi; sözlükten kopyalanmış uzun
 * listeler kısa metinde gürültü üretiyor.
 */
const STOPWORDS: Record<LanguageCode, readonly string[]> = {
  tr: [
    've',
    'bir',
    'bu',
    'için',
    'ile',
    'çok',
    'daha',
    'nasıl',
    'ne',
    'var',
    'yok',
    'en',
    'her',
    'gibi',
    'oldu',
    'yeni',
    'son',
    'kadar',
    'ben',
    'biz',
  ],
  /*
   * Almanca listesi UZUN tutuldu, çünkü Almancanın ayırt edici HARFİ pratikte
   * yok: `ß` nadir, `äöü` ise Türkçeyle ortak (yalnızca zayıf puan). Yani
   * Almanca neredeyse tamamen durak kelimelere bağlı. Kısa listeyle canlı
   * taramada "Doku: Die geheime Welt des deutschen Adels" gibi apaçık Almanca
   * başlıklar bile "bilinmiyor" sayılıp atılıyordu.
   */
  de: [
    'der',
    'die',
    'das',
    'und',
    'ist',
    'ein',
    'eine',
    'einer',
    'einem',
    'eines',
    'nicht',
    'mit',
    'von',
    'für',
    'im',
    'in',
    'auf',
    'wie',
    'was',
    'wir',
    'ich',
    'sich',
    'den',
    'dem',
    'des',
    'warum',
    'jetzt',
    'alle',
    'vor',
    'zu',
    'um',
    'ohne',
    'gegen',
    'über',
    'unter',
    'nach',
    'bei',
    'noch',
    'nur',
    'aber',
    'oder',
    'wenn',
    'doch',
    'schon',
    'immer',
    'alles',
    'mehr',
    'kein',
    'keine',
    'sein',
    'seine',
    'ihre',
    'man',
    'als',
    'am',
    'zum',
    'zur',
    'beim',
    'vom',
    'ins',
    'so',
    'sie',
    'er',
    'es',
    'du',
    'mein',
    'dein',
    'hat',
    'hier',
    'werden',
    'wurde',
    'wird',
    'kann',
    'muss',
    'soll',
    'geht',
    'macht',
    'gibt',
    'doku',
    'folge',
    'teil',
    'jahre',
    'deutschland',
    'deutsche',
    'deutschen',
  ],
  /*
   * İngilizce listesi diğerlerinden UZUN, çünkü dışlanmak istenen baskın dil o.
   * İlk sürüm 20 kelimeydi ve canlı taramada "Don't Look Down! ... from
   * Towering Cliffs" gibi bir başlıkta yalnızca `from` yakalanıyor, eşiğin
   * altında kalıp "dili bilinmiyor" sayılıyordu — `allowUnknownLanguage`
   * varsayılan açık olduğu için de Türkçe filtresinden sızıyordu.
   *
   * Başka dillerle ÇAKIŞAN kelimeler (`a`, `no`, `me`, `do`) bilinçli olarak
   * dışarıda: çakışma berabereye, beraberlik de "bilinmiyor"a düşürüyor ve
   * kazanç götürüyor.
   */
  en: [
    'the',
    'and',
    'of',
    'to',
    'in',
    'for',
    'with',
    'how',
    'why',
    'best',
    'you',
    'my',
    'this',
    'that',
    'is',
    'are',
    'on',
    'we',
    'it',
    'from',
    'what',
    'when',
    'where',
    'who',
    'which',
    'have',
    'has',
    'had',
    'been',
    'they',
    'their',
    'there',
    'about',
    'after',
    'before',
    'into',
    'over',
    'under',
    'out',
    'up',
    'down',
    'off',
    'again',
    'only',
    'very',
    'some',
    'any',
    'because',
    'while',
    'than',
    'then',
    'now',
    'here',
    'more',
    'most',
    'other',
    'such',
    'own',
    'same',
    'too',
    'will',
    'just',
    'don',
    'should',
    'would',
    'could',
    'get',
    'got',
    'make',
    'made',
    'never',
    'ever',
    'a',
    'an',
    'as',
    'at',
    'no',
    'not',
    'all',
    'our',
    'her',
    'his',
    'its',
    'them',
    'us',
    'if',
    'but',
    'or',
    'do',
    'does',
    'did',
    'new',
    'old',
    'without',
    'inside',
    'outside',
    'vs',
    'her',
    'she',
    'he',
    'i',
    'am',
    'be',
    'was',
    'were',
    'first',
    'last',
    'every',
    'much',
    'many',
    'little',
    'big',
    'small',
    'giant',
    'full',
    'real',
    'top',
    'day',
    'days',
    'hours',
    'life',
  ],
  fr: [
    'le',
    'la',
    'les',
    'des',
    'un',
    'une',
    'et',
    'pour',
    'dans',
    'avec',
    'sur',
    'est',
    'que',
    'qui',
    'je',
    'ce',
    'au',
    'du',
  ],
  es: [
    'el',
    'la',
    'los',
    'las',
    'de',
    'que',
    'con',
    'para',
    'un',
    'una',
    'por',
    'en',
    'es',
    'su',
    'como',
    'mi',
  ],
  it: [
    'il',
    'lo',
    'la',
    'di',
    'che',
    'con',
    'per',
    'un',
    'una',
    'del',
    'non',
    'come',
    'più',
    'sono',
  ],
  pt: ['o', 'a', 'de', 'que', 'com', 'para', 'um', 'uma', 'do', 'da', 'não', 'como', 'mais', 'eu'],
  ru: [],
  ar: [],
  ja: [],
  ko: [],
  zh: [],
  hi: [],
};

/**
 * Küçük harfe çevirme — Türkçenin iki tuzağıyla birlikte.
 *
 * 1. `İ` (noktalı büyük I) İngilizcede yok, yani ayırt edici bir Türkçe
 *    işaretidir. Ama `toLowerCase()` onu `i` + birleşen nokta (U+0307) yapıyor
 *    ve "İÇİN" gibi bir kelime durak listesindeki "için" ile eşleşmiyor.
 *    O yüzden önce sade `i`'ye indiriyoruz.
 *
 * 2. `I`'yı `ı`'ya ÇEVİRMİYORUZ — ilk denememde çeviriyordum ve bu bir
 *    yanlış-pozitif fabrikasıydı: "How It Works" → "how ıt works" olup Türkçe
 *    sinyali üretiyordu, çünkü TÜM CAPS İngilizce başlıklar I harfiyle dolu.
 *    Büyük `I` iki dilde de var, yani AYIRT EDİCİ DEĞİL; öyleymiş gibi
 *    davranmak Türkçe filtresine yabancı içerik sızdırırdı.
 *
 * Türkçe TÜM CAPS başlıklar yine yakalanıyor: `İ`, `Ğ`, `Ş` bu metinlerde
 * neredeyse her zaman bulunuyor ve hepsi tek başına belirleyici.
 */
function foldCase(text: string): string {
  return text.replace(/İ/g, 'i').toLowerCase();
}

/** `İ` katlamada kaybolduğu için ham metinde ayrıca aranıyor. */
const TURKISH_DOTTED_I = /İ/;

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** Puanlar bu eşiğin altındaysa dil "bilinmiyor" sayılır. */
const MIN_SCORE = 2;

/**
 * Başlığın dilini tahmin eder; ayırt edemiyorsa `null`.
 *
 * Puanlama: ayırt edici harf +4, zayıf harf +1, her durak kelime +1 (en fazla 3).
 * Bir dilin öne çıkması için hem eşiği geçmesi hem de ikinciyi geçmesi gerekiyor
 * — berabere kalan iki dil "bilinmiyor" demektir, uydurma değil.
 */
export function detectLanguage(text: string | null | undefined): LanguageCode | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // Alfabe tek başına belirleyiciyse orada bitiyor.
  for (const { code, pattern } of SCRIPTS) {
    if (pattern.test(trimmed)) return code;
  }

  const folded = foldCase(trimmed);
  const words = new Set(folded.split(WORD_SPLIT).filter((w) => w.length > 0));
  const scores = new Map<LanguageCode, number>();
  const add = (code: LanguageCode, points: number): void => {
    scores.set(code, (scores.get(code) ?? 0) + points);
  };

  /*
   * Desenler KATLANMIŞ metinde çalışıyor, ham metinde değil.
   *
   * YouTube başlıkları sık sık TÜM CAPS ve Türkçede `ı`'nın büyüğü `I`. Ham
   * metne bakan bir kontrol "İDDİALI" gibi bir başlıkta en ayırt edici harfi
   * göremezdi — yani tam da işe yarayacağı yerde kör kalırdı.
   */
  /*
   * Ayırt edici harf, durak kelimelerin TOPLAMINDAN ağır basar (4 > 3 tavanı).
   *
   * Gerekçe kanıt gücü: `ş` gibi bir harf o dile neredeyse özgüdür, oysa
   * yardımcı fiiller diller arasında dolaşır. Eşit tartıldığında "Sibel Can,
   * Ural and the Nuriş Family" gibi karışık bir başlıkta İngilizce kalıp
   * Türkçe harfle berabere kalıyor ve sonuç "bilinmiyor"a düşüyordu.
   */
  for (const { code, strong, weak } of LETTERS) {
    if (strong.test(folded)) add(code, 4);
    else if (weak?.test(folded) === true) add(code, 1);
  }
  // `İ` katlamada `i`'ye indiği için ayrıca ham metinde aranıyor.
  if (TURKISH_DOTTED_I.test(trimmed)) add('tr', 4);

  for (const [code, list] of Object.entries(STOPWORDS) as [LanguageCode, string[]][]) {
    let hits = 0;
    for (const word of list) if (words.has(word)) hits += 1;
    if (hits > 0) add(code, Math.min(hits, 3));
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  if (best === undefined || best[1] < MIN_SCORE) return null;
  // Berabere = ayırt edemedik. Rastgele birini seçmek sessiz bir yalan olurdu.
  if (ranked[1] !== undefined && ranked[1][1] === best[1]) return null;
  return best[0];
}

/**
 * Kartın dili: önce başlık, anlaşılmazsa KANAL ADI.
 *
 * Ölçülen gerçek boşluk (Almanca tarama, 838 video): kartların %37.7'sinde
 * başlıktan dil çıkarılamıyordu — "Gaming GPU Test 2026" gibi başlıklar hiçbir
 * dil sinyali taşımıyor. Kanal adı ("Türkçe Dizi Dünyası", "Kumsaati Hanem")
 * çoğu zaman başlıktan daha güvenilir ve o da ZATEN KARTTA, yani bu yedek de
 * bedava — ek istek yok.
 *
 * Sıra önemli: başlık videoya özgü, kanal adı kanala. Başlık okunabildiğinde
 * ona güveniyoruz; Türkçe bir kanalın İngilizce videosu Türkçe sayılmamalı.
 */
export function detectCardLanguage(
  title: string | null | undefined,
  channelName?: string | null | undefined,
): LanguageCode | null {
  return detectLanguage(title) ?? detectLanguage(channelName);
}

/**
 * Yürüyüş kararı.
 *
 * `'accepted'` üstünden yürünür, `'mismatch'` yürünmez, `'unknown'` kararı
 * `allowUnknown`'a bırakır. `checkCountry` ile aynı üçlü — kod tabanında bu
 * kalıp zaten var ve "bilinmiyor"u "eşleşmedi"den ayırmak önemli.
 */
export function checkLanguage(
  title: string | null | undefined,
  wanted: readonly string[] | null,
  allowUnknown: boolean,
  channelName?: string | null | undefined,
): 'accepted' | 'mismatch' | 'unknown' {
  if (!languageFilterActive(wanted)) return 'accepted';
  const detected = detectCardLanguage(title, channelName);
  if (detected === null) return allowUnknown ? 'accepted' : 'unknown';
  return wanted.some((w) => w.toLowerCase() === detected) ? 'accepted' : 'mismatch';
}

export function languageFilterActive(wanted: readonly string[] | null): wanted is string[] {
  return wanted !== null && wanted.length > 0;
}
