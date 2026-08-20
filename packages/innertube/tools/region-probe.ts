/**
 * Bölge probu — "YouTube beni nerede sanıyor?"
 *
 * Canlı YouTube'a bağlanır; testlerde ASLA çalışmaz, elle çalıştırılır.
 *
 * Var oluş sebebi: "ülke seç" özelliğinin gerçekten çalışıp çalışmadığını
 * TAHMİN etmek yerine ölçmek. YouTube'un coğrafya inancı iki ayrı şeyden
 * besleniyor olabilir — bizim BEYANIMIZ (`context.client.gl`) ve YouTube'un
 * IP'mizden kendi ÇIKARIMI. İkisi ayrışıyorsa ücretsiz kaldıraçların bir
 * tavanı var demektir ve bunu baştan bilmek gerekir.
 *
 * `/sw.js_data` bu soruya tek istekle cevap veriyor: youtubei.js oturum
 * kurarken bu uca gidip `device_info` dizisinden YouTube'un çıkardığı `gl`'yi,
 * gördüğü genel IP'yi ve mintlediği visitorData'yı okuyor
 * (youtubei.js 17.2.0, `dist/src/core/Session.js:235-260`).
 *
 * Kullanım:
 *   pnpm --filter @hype/innertube probe:region        # varsayılan TR
 *   pnpm --filter @hype/innertube probe:region DE
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KvRepo } from '@hype/core';
import { sameCountry, systemClock, systemRng, systemSleeper } from '@hype/core';
import { classifyRequestUrl, RequestGovernor } from '../src/governor.js';
import { createInnertubeAdapter } from '../src/index.js';
import { timezoneFor } from '../src/regions.js';
import type { FetchLike } from '../src/session.js';

const PROBE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'probes');
const SW_URL = 'https://www.youtube.com/sw.js_data';

/**
 * YouTube'un bize dair çıkarımları. Alan indeksleri youtubei.js'in
 * `#getSessionData`'sından birebir alındı — şema değişirse burası da bozulur,
 * o yüzden okumalar savunmacı.
 */
interface DeviceFacts {
  /** YouTube'un IP'mizden çıkardığı ülke. ASIL ÖLÇTÜĞÜMÜZ ŞEY. */
  gl: string | null;
  hl: string | null;
  /** YouTube'un gördüğü genel IP'miz. */
  remoteHost: string | null;
  /**
   * Sunucunun mintlediği kimlik. DECODE EDİLMİYOR: kütüphanenin protosu
   * yalnızca {id, timestamp} modelliyor ve bilinmeyen alanları sessizce
   * düşürüyor, yani decode edip bakmak yanıltıcı olur. Ham uzunluk,
   * "içinde bizim görmediğimiz alanlar var mı" sorusunun dürüst vekili.
   */
  visitorDataChars: number | null;
  visitorDataBytes: number | null;
}

interface Variant {
  name: string;
  detail: string;
  url: string;
  cookie: string;
}

function buildVariants(region: string): Variant[] {
  const tz = timezoneFor(region).replace('/', '.');
  return [
    {
      name: 'düz',
      detail: 'hiçbir bölge sinyali yok — taban çizgisi',
      url: SW_URL,
      cookie: `PREF=tz=${tz};`,
    },
    {
      name: 'PREF çerezi',
      detail: `PREF içinde gl=${region}`,
      url: SW_URL,
      // Kütüphane zaten PREF=tz=... gönderiyor; biz yalnızca gl'yi ekliyoruz.
      cookie: `PREF=gl=${region}&hl=en&tz=${tz};`,
    },
    {
      name: 'persist_gl',
      detail: `?gl=${region}&persist_gl=1 — FreeTube'un yöntemi`,
      url: `${SW_URL}?gl=${region}&persist_gl=1`,
      cookie: `PREF=tz=${tz};`,
    },
  ];
}

/** `)]}'` önekli JSPB yanıtını çözüp `device_info` dizisini çıkarır. */
function readDeviceInfo(text: string): unknown[] | null {
  if (!text.startsWith(")]}'")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\)\]\}'/, ''));
  } catch {
    return null;
  }
  // data[0][2][0][0] — youtubei.js: `const [[device_info]] = data[0][2]`
  const ytcfg = (parsed as unknown[] | undefined)?.[0];
  const config = (ytcfg as unknown[] | undefined)?.[2];
  const first = (config as unknown[] | undefined)?.[0];
  const deviceInfo = (first as unknown[] | undefined)?.[0];
  return Array.isArray(deviceInfo) ? deviceInfo : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toFacts(deviceInfo: unknown[]): DeviceFacts {
  const visitorData = str(deviceInfo[13]);
  return {
    hl: str(deviceInfo[0]),
    gl: str(deviceInfo[1]),
    remoteHost: str(deviceInfo[3]),
    visitorDataChars: visitorData === null ? null : visitorData.length,
    visitorDataBytes:
      visitorData === null ? null : Buffer.from(visitorData, 'base64url').byteLength,
  };
}

/* ─────────────────────────── Prob B / C altyapısı ─────────────────────────── */

/** Tüm problar TEK hız yöneticisinden geçer; yoksa paralel adaptörler YouTube'u döver. */
function sharedGovernor(): RequestGovernor {
  return new RequestGovernor({ clock: systemClock, sleeper: systemSleeper, rng: systemRng });
}

/**
 * Her koşul için TAZE kimlik.
 *
 * Denetim literatürünün ilk kuralı: kimlik koşullar arasında paylaşılırsa
 * ölçtüğünüz şey bölge değil, birikmiş kişiselleştirme olur. Ephemeral KV bunu
 * garanti ediyor — hiçbir şey saklanmıyor.
 */
function freshAdapter(region: string, governor: RequestGovernor) {
  const paced: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    await governor.acquire(classifyRequestUrl(url), undefined);
    return fetch(input, init);
  };

  return createInnertubeAdapter({
    kv: ephemeralKv,
    clock: systemClock,
    sleeper: systemSleeper,
    rng: systemRng,
    baseFetch: paced,
    defaultRegion: region,
    // Hız kontrolü dışarıdaki paylaşılan yöneticide; içteki iki kez beklemesin.
    governor: { minIntervalMs: 0, maxIntervalMs: 1, burstCapacity: 1000 },
  });
}

const ephemeralKv: KvRepo = {
  async get() {
    return null;
  },
  async set() {
    /* prob kimliği saklamaz — her koşul taze başlar */
  },
};

function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let shared = 0;
  for (const id of sa) if (sb.has(id)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

/** İki dilli KASITLI: dil ile bölgeyi ayrı değişken olarak ayırmanın tek yolu. */
const QUERIES = [
  { q: 'documentary', lang: 'EN' },
  { q: 'cooking recipe', lang: 'EN' },
  { q: 'belgesel', lang: 'TR' },
  { q: 'yemek tarifi', lang: 'TR' },
] as const;

/** `US2` gerçek bir bölge değil: US'in ikinci koşusu, yani GÜRÜLTÜ TABANI. */
const ARMS = ['US', 'US2', 'TR', 'DE'] as const;

async function probeB(governor: RequestGovernor) {
  console.log('\n── Prob B: arama örtüşmesi ───────────────────────────────────\n');
  const controller = new AbortController();
  /** kol → sorgu → videoId listesi */
  const seen: Record<string, Record<string, string[]>> = {};

  for (const arm of ARMS) {
    const region = arm === 'US2' ? 'US' : arm;
    const { gateway } = freshAdapter(region, governor);
    seen[arm] = {};
    for (const { q } of QUERIES) {
      try {
        const cards = await gateway.fetchSearchFeed(q, controller.signal);
        seen[arm][q] = cards.filter((c) => c.kind === 'video').map((c) => c.videoId);
      } catch (error) {
        console.log(`  ${arm}/${q}: HATA ${String(error).slice(0, 60)}`);
        seen[arm][q] = [];
      }
    }
    console.log(`  ${arm.padEnd(4)} tamam`);
  }

  console.log(
    `\n${'sorgu'.padEnd(18)}${'dil'.padEnd(5)}${'US↔US2'.padEnd(9)}${'US↔TR'.padEnd(9)}US↔DE`,
  );
  console.log('─'.repeat(52));
  const rows: Record<string, unknown>[] = [];
  for (const { q, lang } of QUERIES) {
    const base = seen.US?.[q] ?? [];
    const noise = jaccard(base, seen.US2?.[q] ?? []);
    const tr = jaccard(base, seen.TR?.[q] ?? []);
    const de = jaccard(base, seen.DE?.[q] ?? []);
    rows.push({ query: q, lang, noise, tr, de });
    console.log(
      `${q.padEnd(18)}${lang.padEnd(5)}${noise.toFixed(2).padEnd(9)}${tr.toFixed(2).padEnd(9)}${de.toFixed(2)}`,
    );
  }
  return { rows, seen };
}

async function probeC(governor: RequestGovernor, seeds: readonly string[]) {
  console.log('\n── Prob C: komşu kanalların ülkesi ───────────────────────────\n');
  const controller = new AbortController();
  const rows: Record<string, unknown>[] = [];

  for (const region of ['US', 'TR', 'DE'] as const) {
    const { gateway } = freshAdapter(region, governor);
    const channelIds = new Set<string>();
    for (const videoId of seeds) {
      try {
        const page = await gateway.fetchWatchNext(videoId, controller.signal);
        for (const card of page.cards) if (card.channelId !== null) channelIds.add(card.channelId);
      } catch (error) {
        console.log(`  ${region}/${videoId}: HATA ${String(error).slice(0, 50)}`);
      }
    }

    /*
     * Örneklem 20. İlk koşuda 8'di ve o kadarıyla "TR %50, US %25" gibi
     * farklar iki kanalın oynamasıyla oluşuyordu — yani gürültüydü. Ülke
     * sorgusu ucuz (sınıf A) olduğu için burada cimrilik etmeye değmez.
     */
    const sample = [...channelIds].slice(0, 20);
    const countries: (string | null)[] = [];
    for (const channelId of sample) {
      try {
        countries.push((await gateway.fetchChannelAbout(channelId, controller.signal)).country);
      } catch {
        countries.push(null);
      }
    }

    const named = countries.filter((c): c is string => c !== null);
    const target = named.filter((c) => sameCountry(c, region)).length;
    const row = {
      region,
      sampled: sample.length,
      known: named.length,
      targetShare: sample.length === 0 ? 0 : target / sample.length,
      countries: named,
    };
    rows.push(row);
    console.log(
      `  ${region.padEnd(4)} ${sample.length} kanal · ülkesi bilinen ${named.length} · hedef ülke oranı ${(row.targetShare * 100).toFixed(0)}%`,
    );
    console.log(`       ${named.join(', ') || '—'}`);
  }
  return rows;
}

/** Prob C'nin tohumları TÜM bölgelerde aynı olmalı, yoksa tohum farkı ölçüme karışır. */
async function pickSharedSeeds(governor: RequestGovernor): Promise<string[]> {
  const { gateway } = freshAdapter('US', governor);
  const cards = await gateway.fetchSearchFeed('documentary', new AbortController().signal);
  return cards
    .filter((c) => c.kind === 'video')
    .slice(0, 3)
    .map((c) => c.videoId);
}

/**
 * Karar kuralı — ÖNCEDEN yazıldı, sonuçlara bakılarak değil.
 *
 * Amaç, çıkan rakamı sonradan "aslında şöyle de okunabilir" diye eğip bükmeyi
 * imkânsız kılmak. Eşikler plandaki değerler.
 */
function reportVerdict(
  bRows: Record<string, unknown>[] | null,
  cRows: Record<string, unknown>[] | null,
): void {
  console.log('\n── Karar ─────────────────────────────────────────────────────\n');

  if (bRows !== null) {
    const num = (row: Record<string, unknown>, key: string) => Number(row[key] ?? 0);

    /*
     * ANA KARŞILAŞTIRMA `DE`, `TR` DEĞİL.
     *
     * İlk koşuda kuralı US↔TR üzerine kurmuştum; bu bir kusurdu. Kendi IP'miz
     * Türkiye olduğu için o sütun tanımı gereği bulanık: YouTube `gl`'yi kısmen
     * yok sayıp IP'ye dönse bile US ve TR kolları benzer çıkabilir. Bölge
     * etkisini görmek için IP'mizden UZAK bir bölge gerekiyor.
     *
     * Ayrıca ORTALAMA yanıltıcı: etki sorgudan sorguya değişiyor ve asıl bulgu
     * bu değişkenliğin kendisi. O yüzden sorgu sorgu sayıyoruz.
     */
    const REAL_SHIFT = 0.2;
    let shifted = 0;
    console.log('  sorgu bazında (gürültü tabanına göre US↔DE düşüşü):');
    for (const row of bRows) {
      const drop = num(row, 'noise') - num(row, 'de');
      const real = drop >= REAL_SHIFT;
      if (real) shifted += 1;
      const sign = drop >= 0 ? '+' : '';
      console.log(
        `    ${String(row.query).padEnd(18)}${String(row.lang).padEnd(4)}taban ${num(row, 'noise').toFixed(2)} -> DE ${num(row, 'de').toFixed(2)}  dusus ${sign}${drop.toFixed(2)}${real ? '  <- GERCEK KAYMA' : ''}`,
      );
    }

    console.log(`\n  ${shifted}/${bRows.length} sorguda bölge, gürültünün ötesinde fark yarattı.`);
    if (shifted === 0) {
      console.log('  → `gl` arama sonuçlarını DEĞİŞTİRMİYOR. Tohum kaynağımız arama');
      console.log('     olduğu için bölgenin tohum üzerindeki değeri yok.');
    } else if (shifted === bRows.length) {
      console.log('  → `gl` aramayı tutarlı biçimde değiştiriyor: gerçek kaldıraç.');
    } else {
      console.log('  → `gl` BAZI sorgularda güçlü, bazılarında hiç etkili değil.');
      console.log('     Tek bir "çalışıyor/çalışmıyor" cevabı yok; etki sorguya bağlı.');
    }
  }

  if (cRows !== null) {
    /*
     * MATRİS, tek sayı değil.
     *
     * "DE kolunda Alman kanal oranı %13" tek başına hiçbir şey söylemiyor —
     * kıyas noktası "US kolunda Alman kanal oranı". Bölge yönlendirmesi
     * çalışıyorsa KÖŞEGEN (kendi bölgesinin kanalları) diğer kolların aynı
     * ülkedeki oranını aşmalı.
     */
    const arms = ['US', 'TR', 'DE'];
    const shareOf = (arm: string, country: string): number => {
      const row = cRows.find((r) => r.region === arm);
      const list = (row?.countries as string[] | undefined) ?? [];
      const sampled = Number(row?.sampled ?? 0);
      if (sampled === 0) return 0;
      return list.filter((c) => sameCountry(c, country)).length / sampled;
    };

    console.log(`\n  komşu kanal ülkeleri (satır = beyan edilen bölge)\n`);
    console.log(`    ${'kol'.padEnd(6)}${arms.map((a) => `${a} kanalı`.padEnd(11)).join('')}`);
    for (const arm of arms) {
      const cells = arms.map((c) => `${(shareOf(arm, c) * 100).toFixed(0)}%`.padEnd(11)).join('');
      console.log(`    ${arm.padEnd(6)}${cells}`);
    }

    // Kabul metriği: köşegen, aynı ülkenin diğer kollardaki oranını ≥15 puan aşmalı.
    const lifts = arms.map((arm) => {
      const others = arms.filter((a) => a !== arm).map((a) => shareOf(a, arm));
      const rivalMax = others.length === 0 ? 0 : Math.max(...others);
      return { arm, lift: shareOf(arm, arm) - rivalMax };
    });
    console.log('');
    for (const { arm, lift } of lifts) {
      console.log(
        `    ${arm}: kendi ülkesinin kanalları, diğer kollara göre ${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(0)} puan`,
      );
    }
    const winners = lifts.filter((l) => l.lift >= 0.15).map((l) => l.arm);
    console.log(
      winners.length > 0
        ? `\n  → Komşuluk grafı kayıyor: ${winners.join(', ')} kendi ülkesini öne çıkarıyor.`
        : '\n  → Komşuluk grafı bölgeye göre anlamlı kaymıyor (hiçbir kolda ≥15 puan).',
    );

    const n = Number(cRows[0]?.sampled ?? 0);
    if (n < 15) {
      console.log(`  UYARI: örneklem yalnızca ${n} kanal — bu farklar gürültü olabilir.`);
    }
  }
}

async function save(payload: Record<string, unknown>): Promise<void> {
  await mkdir(PROBE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(PROBE_DIR, `region-${stamp}.json`);
  await writeFile(path, `${JSON.stringify({ probedAt: stamp, ...payload }, null, 2)}\n`, 'utf8');
  console.log(`\nHam çıktı: ${path}`);
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? 'a').toLowerCase();
  const region = (process.argv[3] ?? 'DE').toUpperCase();
  const governor = sharedGovernor();

  if (mode === 'b' || mode === 'c' || mode === 'all') {
    const probB = mode === 'c' ? null : await probeB(governor);
    let probC: Record<string, unknown>[] | null = null;
    if (mode === 'c' || mode === 'all') {
      const seeds = await pickSharedSeeds(governor);
      console.log(`\nOrtak tohumlar: ${seeds.join(', ')}`);
      probC = await probeC(governor, seeds);
    }
    reportVerdict(probB?.rows ?? null, probC);
    await save({ mode, probB: probB?.rows ?? null, probC });
    return;
  }

  console.log(`Bölge probu — hedef: ${region}\n`);

  const results: { variant: Variant; facts: DeviceFacts | null; error?: string }[] = [];

  for (const variant of buildVariants(region)) {
    await governor.acquire(classifyRequestUrl(variant.url), undefined);
    try {
      const response = await fetch(variant.url, {
        headers: {
          'Accept-Language': 'en-US',
          Accept: '*/*',
          Referer: 'https://www.youtube.com/sw.js',
          Cookie: variant.cookie,
        },
      });
      if (!response.ok) {
        results.push({ variant, facts: null, error: `HTTP ${response.status}` });
        continue;
      }
      const deviceInfo = readDeviceInfo(await response.text());
      if (deviceInfo === null) {
        results.push({ variant, facts: null, error: 'JSPB şeması okunamadı' });
        continue;
      }
      results.push({ variant, facts: toFacts(deviceInfo) });
    } catch (error) {
      results.push({ variant, facts: null, error: String(error) });
    }
  }

  console.log(
    `${'varyant'.padEnd(14)}${'YouTube gl'.padEnd(12)}${'hl'.padEnd(8)}${'IP'.padEnd(18)}visitorData`,
  );
  console.log('─'.repeat(70));
  for (const { variant, facts, error } of results) {
    if (facts === null) {
      console.log(`${variant.name.padEnd(14)}HATA: ${error ?? 'bilinmiyor'}`);
      continue;
    }
    const vd =
      facts.visitorDataBytes === null
        ? '—'
        : `${facts.visitorDataBytes}B (${facts.visitorDataChars} kr)`;
    console.log(
      `${variant.name.padEnd(14)}${(facts.gl ?? '—').padEnd(12)}${(facts.hl ?? '—').padEnd(8)}${(facts.remoteHost ?? '—').padEnd(18)}${vd}`,
    );
  }

  /*
   * Sonuç DAİMA taban çizgisine göre okunur.
   *
   * "Bir varyant hedef ülkeyi döndürdü mü?" diye sormak yanıltıcı: kendi IP'niz
   * zaten o ülkedeyse üç varyant da hedefi döndürür ve hiçbir şey kanıtlamaz.
   * Doğru soru "sinyallerimiz, hiçbir şey göndermediğimiz duruma göre YouTube'un
   * çıkarımını DEĞİŞTİRDİ mi?"
   */
  const baseline = results[0]?.facts?.gl ?? null;
  const changed = results
    .slice(1)
    .filter((r) => r.facts?.gl != null && r.facts.gl !== baseline)
    .map((r) => `${r.variant.name} → ${r.facts?.gl}`);

  console.log('');
  if (baseline === null) {
    console.log('Taban çizgisi okunamadı — şema değişmiş olabilir, sonuç çıkarılamaz.');
    return;
  }

  console.log(`Taban çizgisi (hiçbir sinyal yok): YouTube bizi ${baseline} sanıyor.`);
  if (baseline.toUpperCase() === region) {
    console.log(`UYARI: hedef bölge (${region}) zaten kendi IP bölgeniz. Bu koşu, sinyallerin`);
    console.log('       işe yarayıp yaramadığını ÖLÇEMEZ — başka bir bölgeyle tekrarlayın.');
  }

  if (changed.length > 0) {
    console.log(`SONUÇ: sinyaller çıkarımı değiştirdi — ${changed.join(', ')}`);
    console.log('       `gl` beyanı gerçek bir kaldıraç → Adım 1 anlamlı.');
  } else {
    console.log(`SONUÇ: hiçbir sinyal çıkarımı değiştirmedi, hepsi ${baseline} kaldı.`);
    console.log("       YouTube'un coğrafya inancı IP'ye bağlı. Bu, `gl`'nin ARAMA");
    console.log('       SONUÇLARINI etkilemediği anlamına gelmez — onu Adım 2 ölçecek.');
  }

  await mkdir(PROBE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(PROBE_DIR, `region-${stamp}.json`);
  await writeFile(
    path,
    `${JSON.stringify(
      {
        region,
        probedAt: new Date().toISOString(),
        results: results.map(({ variant, facts, error }) => ({
          variant: variant.name,
          detail: variant.detail,
          url: variant.url,
          cookie: variant.cookie,
          facts,
          ...(error === undefined ? {} : { error }),
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`\nHam çıktı: ${path}`);
}

main().catch((error: unknown) => {
  console.error('Prob başarısız:', error);
  process.exitCode = 1;
});
