import { languageForRegion } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { checkLanguage, detectCardLanguage, detectLanguage } from './language.js';

describe('dil algılama', () => {
  it('Türkçe başlıkları ayırt eder', () => {
    expect(detectLanguage("Japonya'da hiçbir şey göründüğü gibi değil (1. Bölüm)")).toBe('tr');
    expect(detectLanguage('Ümit Özdağ ile Özel Röportaj | 7 Ağustos')).toBe('tr');
    expect(detectLanguage('köy hayatı ve doğal yaşam')).toBe('tr');
  });

  it('TÜM CAPS Türkçe başlıkta ı harfi kaybolmaz', () => {
    /*
     * Bu testin varlık sebebi somut: standart `toLowerCase()` Türkçede `I` → `i`
     * üretir, oysa Türkçede `I`'nın küçüğü `ı`'dır. YouTube başlıklarının çoğu
     * TÜM CAPS olduğu için, bu tuzağa düşen bir algılayıcı tam da en ayırt edici
     * harfimizi göremezdi.
     */
    expect(detectLanguage('YAYINCI BENİMLE DALGA GEÇTİ... 50.000 UC İDDİALI VS ATTIK!')).toBe('tr');
    expect(detectLanguage('O ESKİ HALİMDEN ESER YOK ŞİMDİ')).toBe('tr');
  });

  it('TÜM CAPS İngilizce başlık Türkçe sanılmaz', () => {
    /*
     * İlk uygulamada `I` harfini `ı`'ya katlıyordum ("Türkçede I'nın küçüğü
     * ı'dır" kuralı) ve bu bir yanlış-pozitif fabrikasıydı: TÜM CAPS İngilizce
     * başlıklar I harfiyle dolu olduğu için hepsi Türkçe sinyali üretiyordu.
     * Büyük `I` iki dilde de var, yani ayırt edici değil.
     */
    expect(detectLanguage('HOW IT WORKS: THE BIGGEST SHIP IN THE WORLD')).toBe('en');
    expect(detectLanguage('THIS IS MY BIGGEST MISTAKE')).toBe('en');
  });

  it('canlı taramada sızan başlık artık yakalanıyor', () => {
    /*
     * Gerçek regresyon: bu başlık Türkçe filtresinden geçmişti. Sebebi
     * "eşleşmedi" değil "dili anlaşılamadı"ydı — İngilizce durak listesi
     * o kadar kısaydı ki yalnızca `from` yakalanıyor, eşiğin altında kalıyordu.
     * `allowUnknownLanguage` varsayılan açık olduğu için de içeri sızıyordu.
     */
    expect(
      detectLanguage("Don't Look Down! Harvesting a Giant 20kg Wild Beehive from Towering Cliffs"),
    ).toBe('en');
    expect(
      checkLanguage("Don't Look Down! Harvesting a Giant Wild Beehive from Cliffs", ['tr'], true),
    ).toBe('mismatch');
  });

  it('Almanca ve İngilizceyi ayırır', () => {
    expect(detectLanguage('Wie funktioniert das eigentlich? Die ganze Geschichte')).toBe('de');
    expect(detectLanguage('How It Works: The Best Documentary of the Year')).toBe('en');
  });

  it('Almanca başlıklar durak kelimelerle tanınır (ayırt edici harf yok)', () => {
    /*
     * Almancanın ayırt edici HARFİ pratikte yok: `ß` nadir, `äöü` Türkçeyle
     * ortak. Yani Almanca neredeyse tamamen durak kelimelere bağlı ve liste
     * kısayken apaçık Almanca başlıklar "bilinmiyor" sayılıyordu.
     *
     * Aşağıdakiler CANLI taramadan (801 video, Almanca filtre): hepsi
     * atılmıştı. Ölçüm: eskiden bilinmeyen 259 başlığın %48'i artık çözülüyor,
     * 96'sı Almanca.
     */
    expect(detectLanguage('Doku: Die geheime Welt des deutschen Adels')).toBe('de');
    expect(detectLanguage('Endlich Urlaub! Und jetzt?! | Nachtcafé')).toBe('de');
    expect(detectLanguage('Kristian lebt ohne Luxus & Smartphone in einer Scheune')).toBe('de');
    expect(detectLanguage('Warum jetzt alle vor Weihnachten zu Walmart rennen')).toBe('de');
    expect(detectLanguage('Immer mehr Bauern geben auf - Anthony Lee bei Monika Gruber')).toBe(
      'de',
    );
  });

  it('karışık başlıkta ayırt edici harf ağır basar', () => {
    // Gerçek örnek: İngilizce kalıp + Türkçe özel ad. Yürüyüş açısından doğru
    // cevap Türkçedir — bu kanalın komşuları Türkçe olacak.
    expect(detectLanguage('Bedroom Gang | Sibel Can, Ural and the Nuriş Family')).toBe('tr');
  });

  it('alfabesi belirleyici diller tek bakışta çözülür', () => {
    expect(detectLanguage('Досмотр на российской границе')).toBe('ru');
    expect(detectLanguage('خشوع وإبداع لا يوصف')).toBe('ar');
    expect(detectLanguage('日本のドキュメンタリー')).toBe('ja');
    expect(detectLanguage('한국어 다큐멘터리')).toBe('ko');
  });

  it('AYIRT EDEMEZSE null döner, tahmin etmez', () => {
    /*
     * `text-parse.ts` ile aynı ilke: okunamayan bir değer asla varsayılana
     * kıvrılmaz. Uydurulmuş bir dil, yanlış kenardan yürümeye yol açar ve
     * hatanın kaynağı görünmez olur.
     */
    expect(detectLanguage('MrBeast 2026')).toBeNull();
    expect(detectLanguage('🔥🔥🔥')).toBeNull();
    expect(detectLanguage('')).toBeNull();
    expect(detectLanguage(null)).toBeNull();
    expect(detectLanguage('   ')).toBeNull();
  });

  it('ayırt edici harfsiz, durak kelimesiz Türkçe başlık BİLİNMİYOR sayılır', () => {
    // Bilinen sınır: "ARABA TAMIRI" hiçbir sinyal taşımıyor. Bunu "Türkçe"
    // saymak, algılayıcının gerçekte olduğundan emin görünmesi olurdu.
    expect(detectLanguage('ARABA TAMIRI')).toBeNull();
  });

  it('berabere kalan iki dil bilinmiyor sayılır', () => {
    // Rastgele birini seçmek sessiz bir yalan olurdu.
    expect(detectLanguage('das ve')).toBeNull();
  });
});

describe('yürüyüş kararı', () => {
  it('filtre kapalıysa her şey kabul', () => {
    expect(checkLanguage('anything at all', null, false)).toBe('accepted');
    expect(checkLanguage('anything at all', [], false)).toBe('accepted');
  });

  it('eşleşen dil kabul, eşleşmeyen ret', () => {
    expect(checkLanguage('köy hayatı ve doğal yaşam', ['tr'], false)).toBe('accepted');
    expect(checkLanguage('How It Works: The Best Documentary', ['tr'], false)).toBe('mismatch');
  });

  it('bilinmeyen dil ayrı bir durum — sessizce elenmez', () => {
    expect(checkLanguage('MrBeast 2026', ['tr'], false)).toBe('unknown');
    expect(checkLanguage('MrBeast 2026', ['tr'], true)).toBe('accepted');
  });

  it('birden fazla dil aynı anda istenebilir', () => {
    expect(checkLanguage('Wie funktioniert das eigentlich?', ['tr', 'de'], false)).toBe('accepted');
  });
});

describe('kanal adı yedeği', () => {
  it('başlık sinyalsizse kanal adına bakılır', () => {
    /*
     * Ölçülen boşluk: Almanca taramada 838 kartın %37.7'sinde başlıktan dil
     * çıkmıyordu ("Gaming GPU Test 2026" gibi). Kanal adı da zaten kartta,
     * yani bu yedek bedava.
     */
    expect(detectCardLanguage('Gaming GPU Test 2026')).toBeNull();
    expect(detectCardLanguage('Gaming GPU Test 2026', 'Türkçe Teknoloji Kanalı')).toBe('tr');
    expect(detectCardLanguage('RTX 5090 Benchmark', 'Wissenschaft für alle')).toBe('de');
  });

  it('BAŞLIK okunabildiğinde kanal adı ezmez', () => {
    // Türkçe bir kanalın İngilizce videosu Türkçe sayılmamalı: başlık videoya
    // özgü, kanal adı yalnızca son çare.
    expect(detectCardLanguage('How It Works: The Best Documentary', 'Belgesel Dünyası')).toBe('en');
  });

  it('ikisi de sinyalsizse yine bilinmiyor', () => {
    expect(detectCardLanguage('MrBeast 2026', 'MrBeast')).toBeNull();
    expect(checkLanguage('MrBeast 2026', ['tr'], false, 'MrBeast')).toBe('unknown');
  });

  it('yürüyüş kararı kanal adını kullanır', () => {
    expect(checkLanguage('Gaming GPU Test 2026', ['de'], false, 'Wissenschaft für alle')).toBe(
      'accepted',
    );
    expect(checkLanguage('Gaming GPU Test 2026', ['de'], false, 'Belgesel Dünyası')).toBe(
      'mismatch',
    );
  });
});

describe('bölge → dil (tek tablo @hype/shared REGIONS)', () => {
  it('bilinen bölgeler eşlenir', () => {
    expect(languageForRegion('TR')).toBe('tr');
    expect(languageForRegion('de')).toBe('de');
    expect(languageForRegion('BR')).toBe('pt');
  });

  it('bilinmeyen bölge null — uydurma dil önerilmez', () => {
    expect(languageForRegion('ZZ')).toBeNull();
    expect(languageForRegion(null)).toBeNull();
  });
});
