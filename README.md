# YouTube Hype Radar

YouTube'un öneri ağında otonom gezinerek iki şey arayan yerel araç: **patlayan
videolar** ve **yükselen kanallar**. InnerTube tabanlı tarayıcı + canlı web paneli.

## Çalıştırma

```bash
pnpm install
pnpm dev:all      # sunucu (127.0.0.1:5178) + arayüz (127.0.0.1:5179)
```

Panel: **http://localhost:5179** (ya da http://127.0.0.1:5179)

Yalnızca loopback'e bağlanır — ağdan erişilemez. Veritabanı `data/hype.db`.

## İki av modu

Panelden **Av modu** ile seçilir. Gezinme, hız yönetimi ve eleme kapılarının çoğu
ortaktır; ayrıldıkları yer *neyin* skorlandığıdır.

### Video avı — patlayan tek videolar

Bir videonun, KENDİ kanalının normalinin kaç katını aldığını arar. Çıktı: video.

### Kanal avı — yükselen kanallar

Kısa sürede açılmış ve videoları istikrarlı biçimde çok izlenen kanalları arar.
Çıktı: **kanal başına tek kart**, en çok izlenen videosu temsilci.

Bu, video avının yapısal olarak göremediği şeydir: her videosu tutan bir kanalın
medyanı zaten yüksektir, dolayısıyla hiçbir videosu sivrilmez ve kanal 1–2x
skorlarla elenir.

Modun **iki kapısı** vardır, başka kapı yoktur:

| Ayar | Varsayılan | Ne sorar |
|---|---|---|
| `maxChannelAgeDays` | 180 | Kanal ne kadar yeni? Kuruluş tarihi *Hakkında* sekmesinden okunur. |
| `minChannelMedianViews` | 10.000 | Videolarının **medyanı** kaç izleniyor? |

Bilinçli olarak ikiye indirildi. Önceden bir "isabet oranı" eşiği ve ayrı bir
"başarı tabanı" da vardı; ikisi de aynı fikrin farklı yüzleriydi ve üç sayının
birbirini nasıl etkilediğini kestirmek imkânsızdı. İsabet oranı hâlâ kartta
gösteriliyor ama hiçbir şeyi elemiyor.

İki tasarım kararı özellikle önemli:

- **Kapı medyanda durur, maksimumda değil.** Tek videosu patlamış bir kanal
  maksimumla geçerdi; medyanla geçemez. "İstikrarlı biçimde çok izleniyor" fikri
  böylece ayrı bir istikrar eşiğine gerek kalmadan tek sayının içinde durur.
- **Yaş asla bir kanal "verdikt"i değildir.** Verdiktler kalıcı yazılır; yaş
  verdikt olsaydı kullanıcı eşiği gevşetince eski karar yapışırdı. `joined_at`
  yalnızca VERİ olarak saklanır, karar her taramada config'ten türetilir.

`minChannelUploads` (varsayılan 4) bir kalite eşiği değil, ölçüm zeminidir: iki
videosu olan bir kanalın "medyanı" hakkında konuşmak yanıltıcı olur.

Kanal başına maliyet: en fazla 2 istek (anlık görüntü) + 1 istek (Hakkında,
yalnızca medyan kapısını geçenler için).

## Nasıl çalışıyor

1. **Tohumlama.** Arama üzerinden başlar (`seedQueries`). Ana sayfa da denenir ama
   anonim oturumda YouTube video yerine "giriş yap" kartı döndürür — canlı testte
   doğrulandı. **Tohum terimleri taramanın dilini belirler:** Türkçe içerik için
   Türkçe yazın.
2. **Gezinme.** Öneri rafından epsilon-greedy ile dallanır (%80 en hızlı komşu,
   %20 rastgele — yankı fanusuna girmemek için). Derinlik sınırına gelince yeni
   tohum alır.
3. **Eleme (5 kapı, ucuzdan pahalıya).** Shorts/canlı/liste → yaş, izlenme ve hız
   ön filtresi → kanal önbelleği → kanal isteği → skor eşiği. İlk iki kapı graf
   trafiğinin ~%90'ını bedava eler; kanal isteği tek pahalı adımdır.
4. **Skorlama.** *Video avında* ana metrik: yaş-normalize izlenme ÷ kanalın son
   videolarının **medyanı**. Ortalama kullanılmaz — kanalın önceki tek viral
   videosu ortalamayı zehirler ve tam aradığımız kanalları gizler. Kanal geçmişi
   yoksa abone-oranı (VSR) yedeği devreye girer ve arayüzde **ayrı renkte**
   gösterilir. *Kanal avında* skorlanan birim video değil kanaldır: yukarıdaki
   iki kapı uygulanır, kart mor rozetle ayrılır.

## Bölge ve dil

İkisi de panelde ayrı ayarlardır ve **etkileri eşit değildir** — bu ölçülerek
saptandı, varsayılmadı.

- **Bölge (algoritma)** — istek başlıklarına ülke/saat dilimi/dil beyanı basar.
  YouTube bunu gerçekten görüyor (`/sw.js_data` üzerinden doğrulandı) ama öneri
  grafını kayda değer biçimde **yönlendirmiyor**: ölçümde 15 puanlık eşiğe karşı
  yalnızca +5 puan fark üretti. Panelde de böyle yazıyor; sahte bir vaat
  vermemek için.
- **Yürüyüş dili** — asıl kaldıraç budur. Yandaki önerilerden yalnızca hedef
  dildeki kartların üstünden yürünür. Canlı ölçümde `language_mismatch`
  elemeleri, tohumlar da hedef dilde yazılınca 44'ten 13'e düştü.
- **Ülke (kanal filtresi)** — kanalın *beyan ettiği* ülkeye bakar. Dil filtresi
  yürüyüşü daraltırken (bir taramada 1011 kartın 565'i reddedildi) bu filtre
  yürüyüşü serbest bırakıp elemeyi kanal düzeyinde yapar.

Tohum alanı boş bırakılırsa seçili dile uygun varsayılan konulara düşülür —
Almanca seçiliyken Türkçe "belgesel" yazmak zorunda değilsiniz.

## Havuz görünümü

Sonuç listesinde **görünüm filtresi yoktur.** Elemeyi tarama zaten yapıyor ve bir
taramadan 3–5 kart çıkıyor; onları ikinci bir filtre katmanıyla dilimlemek eleme
değil, kaybetme riski üretiyordu. Nitekim öyle de oldu: görünmeyen bir 5x çarpan
varsayılanı, yakalanan bütün kanalları gizledi (kanal skoru bir video çarpanı
değil, medyan izlenme/abone oranıdır — 320B aboneli gerçek bir yükselen kanalın
oranı 0.05 çıkıyor).

Liste en yeni yakalama başta sıralanır. `geçmiş` düğmesi tüm taramaların
sonuçlarını yükler, `canlıya dön` geri getirir.

## Veri politikası

**Hiçbir şey silinmez.** Elenen videolar bile metrikleriyle saklanır, çünkü asıl
değer sonradan çıkar: "eşiği 3'e düşürseydim geçen ay ne gelirdi?" sorusu ancak
o veri dururken cevaplanabilir. Budama yalnızca açık istek üzerine çalışır
(`pruneArchive`).

## Ban riskine karşı

İstekler arası 1,2–3,2 sn jitter, saatlik tavanlar (700 toplam / 200 pahalı sınıf),
tek kalıcı misafir kimliği (rotasyon yok — geri dönen misafir daha az bot gibi
görünür), proxy yok, giriş yok. InnerTube kısıtlarken çoğu zaman temiz 429
döndürmez, sessizce bozulur; sistem bunu semantik olarak sezip 15–45 dakikalık
mola verir ve mola süresi yeniden başlatmayla sıfırlanmaz.

## Mimari

pnpm monorepo, hexagonal çekirdek:

- `packages/shared` — Zod şemaları, domain tipleri, WS protokolü
- `packages/core` — saf tarama motoru (durum makinesi, filtreler, skorlama); I/O yok
- `packages/innertube` — youtubei.js adaptörü (hız yöneticisi, normalizer)
- `packages/db` — SQLite + Drizzle kalıcılık
- `apps/server` — Fastify REST + WebSocket olay akışı
- `apps/web` — React paneli

`@hype/core` hiçbir altyapı kütüphanesi import etmez; bu sayede tam bir tarama
sahte gateway ve sanal saatle milisaniyede deterministik test edilir.

```bash
pnpm verify   # lint + typecheck + test
pnpm --filter @hype/innertube capture   # canlı YouTube'dan golden fixture yenile
```

## Önemli not (ToS / gayriresmî API)

Bu araç YouTube'un resmî olmayan InnerTube API'sini kullanır ve yalnızca herkese
açık metadata okur; medya indirmez, giriş yapmaz, proxy kullanmaz. İstekler
kasıtlı olarak insan-hızında sınırlandırılmıştır. YouTube Hizmet Şartları'yla
çelişebilir; kişisel araştırma amaçlı, kendi sorumluluğunuzda kullanın.
