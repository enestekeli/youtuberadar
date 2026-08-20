import type { Clock, KvRepo, Rng, Sleeper } from '@hype/core';
import { AbortSignalHolder, InnertubeGateway } from './gateway.js';
import { classifyRequestUrl, type GovernorOptions, RequestGovernor } from './governor.js';
import { RegionHolder } from './regions.js';
import { DEFAULT_REGION, type FetchLike, InnertubeSession } from './session.js';

export * from './errors.js';
export * from './gateway.js';
export * from './governor.js';
export * from './node-facts.js';
export * from './normalize.js';
export * from './parser-telemetry.js';
export * from './regions.js';
export * from './session.js';
export * from './text-parse.js';

export interface AdapterOptions {
  kv: KvRepo;
  clock: Clock;
  sleeper: Sleeper;
  rng: Rng;
  governor?: Omit<GovernorOptions, 'clock' | 'sleeper' | 'rng'>;
  baseFetch?: FetchLike;
  /** Açılış bölgesi; tarama başlarken `session.setRegion` ile değişir. */
  defaultRegion?: string;
}

export interface Adapter {
  gateway: InnertubeGateway;
  governor: RequestGovernor;
  session: InnertubeSession;
}

/**
 * Adaptörü tek parça hâlinde kurar.
 *
 * Kurulum sırası kritik: hız yöneticisi önce yaratılır, fetch'e sarılır, sonra
 * oturum o fetch ile açılır. Böylece oturum açılışının kendi istekleri bile
 * hız ayarına tabi olur.
 */
export function createInnertubeAdapter(options: AdapterOptions): Adapter {
  const governor = new RequestGovernor({
    clock: options.clock,
    sleeper: options.sleeper,
    rng: options.rng,
    ...options.governor,
  });

  const signalHolder = new AbortSignalHolder();
  const regionHolder = new RegionHolder(options.defaultRegion ?? DEFAULT_REGION);
  const base: FetchLike = options.baseFetch ?? ((input, init) => fetch(input, init));

  const governedFetch: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    await governor.acquire(classifyRequestUrl(url), signalHolder.current);

    /*
     * Bölge çerezi BURADA damgalanıyor, `Innertube.create({ cookie })` ile değil.
     * Sebebi somut: oturum açılışındaki ilk istek (`POST /youtubei/v1/config`)
     * kütüphanenin HTTPClient'ından geçmiyor, dolayısıyla oradaki çerez mantığı
     * ona ulaşmıyordu. Bu seviye, YouTube'a giden HER isteği görüyor.
     */
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set('Cookie', regionHolder.cookie());

    return base(input, { ...init, headers });
  };

  const session = new InnertubeSession({
    kv: options.kv,
    fetch: governedFetch,
    regionHolder,
    ...(options.defaultRegion === undefined ? {} : { defaultRegion: options.defaultRegion }),
  });
  const gateway = new InnertubeGateway({ session, clock: options.clock, signalHolder });

  return { gateway, governor, session };
}
