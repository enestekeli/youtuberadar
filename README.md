# YouTube Hype Radar

Düşük aboneli kanallardan, kanalın normal performansının çok üstünde izlenme alan
yatay (Shorts olmayan) videoları otonom tespit eden yerel araç: InnerTube tabanlı
öneri-ağı tarayıcısı + canlı web paneli.

## Çalıştırma

```bash
pnpm install
pnpm dev:all      # sunucu (127.0.0.1:5178) + arayüz (127.0.0.1:5179)
```

Panel: **http://localhost:5179** (ya da http://127.0.0.1:5179)

Yalnızca loopback'e bağlanır — ağdan erişilemez. Veritabanı `data/hype.db`.

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
4. **Skorlama.** Ana metrik: yaş-normalize izlenme ÷ kanalın son videolarının
   **medyanı**. Ortalama kullanılmaz — kanalın önceki tek viral videosu ortalamayı
   zehirler ve tam aradığımız kanalları gizler. Kanal geçmişi yoksa abone-oranı
   (VSR) yedeği devreye girer ve arayüzde **ayrı renkte** gösterilir.

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
