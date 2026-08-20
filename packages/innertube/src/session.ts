import { KV_VISITOR_DATA, KV_VISITOR_DATA_CREATED_AT, type KvRepo } from '@hype/core';
import { Innertube } from 'youtubei.js';
import { type RegionHolder, timezoneFor } from './regions.js';

/** youtubei.js'in beklediği imza (`typeof fetch`). */
export type FetchLike = typeof fetch;

/** Bölge belirtilmediğinde kullanılan varsayılan — bugüne kadarki davranış. */
export const DEFAULT_REGION = 'US';

export interface SessionOptions {
  kv: KvRepo;
  /** Hız yöneticisinden geçen fetch. Tüm InnerTube trafiği buradan akar. */
  fetch: FetchLike;
  now?: () => number;
  /** Başlangıç bölgesi; tarama başlarken `setRegion` ile değişir. */
  defaultRegion?: string;
  /**
   * Bölge çerezini taşıma katmanına duyuran kutu. Verilmezse yalnızca gövdedeki
   * `gl` gönderilir — ölçüm asıl kaldıracın çerez olduğunu gösterdiği için
   * üretimde daima verilmeli (`createInnertubeAdapter` bunu yapıyor).
   */
  regionHolder?: RegionHolder;
}

/**
 * InnerTube oturumu.
 *
 * Üç karar burada gömülü:
 *
 * 1. `retrieve_player: false` — bu araç medya indirmiyor, yalnızca metadata
 *    okuyor. Player JS'i çekmemek hem oturum açılışını hızlandırıyor hem de
 *    PoToken/BotGuard attestation'ına hiç ihtiyaç bırakmıyor (attestation
 *    stream URL'lerini koruyor, browse/next çağrılarını değil).
 *
 * 2. `lang: 'en'` SABİT — ama `location` (yani `gl`) DEĞİL.
 *    Ayrıştırıcıları bağlayan yalnızca dildir: `text-parse.ts` "3 days ago" ve
 *    "12.3K subscribers" gibi İngilizce metinlere çivili. Ülke kodu metin
 *    biçimini etkilemez, o yüzden bölge serbestçe değiştirilebilir.
 *    (Aynı ayrımı Invidious da yapıyor: `hl` sabit "en", yalnızca `gl` değişken.)
 *
 * 3. Bölge sinyali ASIL OLARAK ÇEREZLE gönderiliyor, gövdedeki `gl` ile değil.
 *    Ölçüldü (`tools/region-probe.ts`, 8 Ağu 2026): Türk IP'sinden hiçbir sinyal
 *    göndermeyince YouTube bizi TR sanıyor, `PREF=gl=DE` çerezi gönderince DE
 *    sanıyor. Yani beyan, IP tabanlı çıkarımı geçersiz kılıyor. `location` yine
 *    de gönderiliyor — ikisi tutarlı olsun diye.
 *
 * 4. TEK KALICI visitorData, asla döndürülmüyor. Araştırma açık: her taramada
 *    yeni kimlik üretmek, geri dönen bir misafirden daha bot gibi görünüyor.
 *    Kimlik ancak bot duvarı üst üste temizlenemezse yenileniyor.
 */
export class InnertubeSession {
  private instance: Innertube | null = null;
  private creating: Promise<Innertube> | null = null;
  private region: string;

  constructor(private readonly options: SessionOptions) {
    this.region = normalizeRegion(options.defaultRegion) ?? DEFAULT_REGION;
    options.regionHolder?.set(this.region);
  }

  /** Oturumun o an beyan ettiği bölge — telemetri ve testler için. */
  get currentRegion(): string {
    return this.region;
  }

  /**
   * Tarama bölgesini ayarlar. Oturum ancak bölge GERÇEKTEN değiştiyse atılır:
   * her tarama başında yeniden kurmak boşa istek harcar ve YouTube'a yeni bir
   * parmak izi gösterir.
   */
  setRegion(region: string | null | undefined): void {
    const next = normalizeRegion(region) ?? DEFAULT_REGION;
    if (next === this.region) return;
    this.region = next;
    this.options.regionHolder?.set(next);
    this.instance = null;
    this.creating = null;
  }

  async get(): Promise<Innertube> {
    if (this.instance !== null) return this.instance;
    this.creating ??= this.create();
    try {
      this.instance = await this.creating;
      return this.instance;
    } finally {
      this.creating = null;
    }
  }

  /** Kimliği tazeler. Yalnızca son çare: tekrarlayan bot duvarı temizlenmiyorsa. */
  async rotateIdentity(): Promise<void> {
    this.instance = null;
    this.creating = null;
    await this.options.kv.set(KV_VISITOR_DATA, '');
  }

  private async create(): Promise<Innertube> {
    const stored = await this.options.kv.get(KV_VISITOR_DATA);
    const visitorData = stored !== null && stored.length > 0 ? stored : undefined;

    const innertube = await Innertube.create({
      lang: 'en',
      location: this.region,
      timezone: timezoneFor(this.region),
      // `cookie` seçeneği BİLEREK kullanılmıyor — bkz. `regions.ts`
      // `RegionHolder` yorumu. Çerez taşıma katmanında damgalanıyor ki oturum
      // açılışındaki ilk istek de taşısın.
      retrieve_player: false,
      generate_session_locally: true,
      // TUZAK: `cache` verilmediği için bu bugün no-op. İleride bir `Cache`
      // eklenirse BÖLGE BAŞINA ayrılmak zorunda, yoksa bölgeler birbirinin
      // oturumunu içer ve bölge yönlendirmesi sessizce çalışmaz olur.
      enable_session_cache: true,
      fetch: this.options.fetch,
      ...(visitorData === undefined ? {} : { visitor_data: visitorData }),
    });

    if (visitorData === undefined) {
      const minted = readVisitorData(innertube);
      if (minted !== null) {
        await this.options.kv.set(KV_VISITOR_DATA, minted);
        const now = this.options.now?.() ?? Date.now();
        await this.options.kv.set(KV_VISITOR_DATA_CREATED_AT, String(now));
      }
    }

    return innertube;
  }
}

/**
 * Bölge kodunu normalleştirir. Geçersiz girdi (boş, 2 harften farklı, harf
 * olmayan) `null` döner ve çağıran varsayılana düşer — uydurulmuş bir ülke
 * kodu göndermektense bilinen davranışta kalmak daha güvenli.
 */
function normalizeRegion(region: string | null | undefined): string | null {
  if (typeof region !== 'string') return null;
  const trimmed = region.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/** Oturumun ürettiği misafir kimliğini okur; şema değişirse null döner. */
function readVisitorData(innertube: Innertube): string | null {
  const client = (
    innertube as unknown as { session?: { context?: { client?: { visitorData?: unknown } } } }
  ).session?.context?.client;
  const value = client?.visitorData;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
