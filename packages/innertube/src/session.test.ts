import type { KvRepo } from '@hype/core';
import { seededRng } from '@hype/core';
import { FakeClock } from '@hype/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInnertubeAdapter } from './index.js';
import { prefCookie, timezoneFor } from './regions.js';
import { DEFAULT_REGION, type FetchLike, InnertubeSession } from './session.js';

/** Bellekte KV — testler diske dokunmaz. */
function memoryKv(): KvRepo & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

interface Capture {
  url: string;
  body: string | null;
  cookie: string | null;
}

/**
 * Oturum açılışını ağa çıkmadan yürütür.
 *
 * `generate_session_locally: true` olduğu için kütüphane `/sw.js_data`'ya
 * gitmiyor; ilk gerçek istek `/youtubei/v1/config`. Ona boş ama geçerli bir
 * JSON dönüp isteğin kendisini kaydediyoruz — asıl ölçtüğümüz şey yanıt değil,
 * GÖNDERDİĞİMİZ gövde.
 */
function recordingFetch(): { fetch: FetchLike; calls: Capture[] } {
  const calls: Capture[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const raw = init?.body;
    calls.push({
      url,
      body: typeof raw === 'string' ? raw : null,
      cookie: headers.get('cookie'),
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

/** İlk InnerTube isteğinin gövdesindeki `context.client` bloğu. */
function firstClientContext(calls: readonly Capture[]): Record<string, unknown> | null {
  for (const call of calls) {
    if (call.body === null) continue;
    try {
      const parsed = JSON.parse(call.body) as {
        context?: { client?: Record<string, unknown> };
      };
      if (parsed.context?.client !== undefined) return parsed.context.client;
    } catch {
      /* gövdesi JSON olmayan istek bizi ilgilendirmiyor */
    }
  }
  return null;
}

let kv: ReturnType<typeof memoryKv>;

beforeEach(() => {
  kv = memoryKv();
});

describe('bölge beyanı', () => {
  it('İLK isteğin gövdesinde hedef bölge gider', async () => {
    /*
     * Kullanıcının asıl sorusunun testi: "ülke seçtiğimde YouTube'a atılan ilk
     * ping o ülkeden mi?" Burada ağa hiç dokunmadan kanıtlanıyor.
     */
    const { fetch, calls } = recordingFetch();
    const session = new InnertubeSession({ kv, fetch });
    session.setRegion('DE');
    await session.get();

    const client = firstClientContext(calls);
    expect(client).not.toBeNull();
    expect(client?.gl).toBe('DE');
    // Dil SABİT: ayrıştırıcılar İngilizce metne çivili.
    expect(client?.hl).toBe('en');
  });

  it('bölge çerezi OTURUM AÇILIŞINDAKİ ilk isteğe bile iliştirilir', async () => {
    /*
     * Ölçüm (tools/region-probe.ts) çerezin asıl kaldıraç olduğunu gösterdi;
     * gövdedeki `gl` tek başına YouTube'un çıkarımını değiştirmiyordu.
     *
     * Bu test kütüphanenin bir tuzağını kilitliyor: açılıştaki
     * `POST /youtubei/v1/config` isteği HTTPClient'tan geçmiyor, dolayısıyla
     * `Innertube.create({ cookie })` ona ulaşmıyor. Çerezi taşıma katmanında
     * damgalamamızın sebebi bu.
     *
     * Test GERÇEK kurulum üzerinden gidiyor (`createInnertubeAdapter`); üretim
     * mantığını kopyalayan bir test hiçbir şey kanıtlamazdı.
     */
    const { fetch, calls } = recordingFetch();
    const clock = new FakeClock();
    const { session } = createInnertubeAdapter({
      kv,
      clock,
      sleeper: clock,
      rng: seededRng(1),
      baseFetch: fetch,
      defaultRegion: 'DE',
    });
    await session.get();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.cookie).toBe(prefCookie('DE'));
    }
  });

  it('bölge değişince çerez de değişir', async () => {
    const { fetch, calls } = recordingFetch();
    const clock = new FakeClock();
    const { session } = createInnertubeAdapter({
      kv,
      clock,
      sleeper: clock,
      rng: seededRng(1),
      baseFetch: fetch,
    });
    await session.get();
    const before = calls.length;

    session.setRegion('JP');
    await session.get();

    expect(calls.length).toBeGreaterThan(before);
    expect(calls.at(-1)?.cookie).toBe(prefCookie('JP'));
  });

  it('zaman dilimi bölgeyle tutarlı gider', async () => {
    // gl:'TR' + timeZone:'America/New_York' çelişkili bir parmak izi olurdu.
    const { fetch, calls } = recordingFetch();
    const session = new InnertubeSession({ kv, fetch });
    session.setRegion('TR');
    await session.get();

    expect(firstClientContext(calls)?.timeZone).toBe(timezoneFor('TR'));
  });

  it('bölge verilmezse bugüne kadarki davranış korunur', async () => {
    const { fetch, calls } = recordingFetch();
    const session = new InnertubeSession({ kv, fetch });
    await session.get();

    expect(session.currentRegion).toBe(DEFAULT_REGION);
    expect(firstClientContext(calls)?.gl).toBe(DEFAULT_REGION);
  });

  it('geçersiz bölge kodu varsayılana düşer, uydurulmuş kod gönderilmez', async () => {
    const { fetch, calls } = recordingFetch();
    const session = new InnertubeSession({ kv, fetch });
    session.setRegion('türkiye');
    await session.get();

    expect(session.currentRegion).toBe(DEFAULT_REGION);
    expect(firstClientContext(calls)?.gl).toBe(DEFAULT_REGION);
  });

  it('küçük harfli kod normalleştirilir', () => {
    const session = new InnertubeSession({ kv, fetch: recordingFetch().fetch });
    session.setRegion('de');
    expect(session.currentRegion).toBe('DE');
  });
});

describe('oturum yaşam döngüsü', () => {
  it('bölge değişimi önbelleklenmiş oturumu atar', async () => {
    const { fetch } = recordingFetch();
    const session = new InnertubeSession({ kv, fetch });
    const first = await session.get();

    session.setRegion('DE');
    const second = await session.get();
    expect(second).not.toBe(first);
  });

  it('AYNI bölge oturumu atmaz', async () => {
    /*
     * Her tarama başında `setRegion` çağrılıyor. Bölge değişmediği hâlde
     * oturumu yeniden kurmak hem boşa istek harcar hem de YouTube'a her
     * taramada yeni bir parmak izi gösterir — geri dönen misafir olmaktan çıkarız.
     */
    const { fetch } = recordingFetch();
    const session = new InnertubeSession({ kv, fetch, defaultRegion: 'TR' });
    const first = await session.get();

    session.setRegion('TR');
    session.setRegion('tr');
    expect(await session.get()).toBe(first);
  });

  it('misafir kimliği bir kez üretilip yeniden kullanılır', async () => {
    const { fetch } = recordingFetch();
    const session = new InnertubeSession({ kv, fetch, now: () => 1_754_500_000_000 });
    await session.get();

    const stored = kv.store.get('visitor_data');
    expect(stored).toBeTruthy();
    expect(kv.store.get('visitor_data_created_at')).toBe('1754500000000');

    // Bölge değişse bile kimlik korunur: yeni kimlik daha bot gibi görünür.
    session.setRegion('DE');
    await session.get();
    expect(kv.store.get('visitor_data')).toBe(stored);
  });
});
