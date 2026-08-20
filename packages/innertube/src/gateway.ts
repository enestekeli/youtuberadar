import type { ChannelAbout, Clock, VideoDetails, WatchNextPage, YouTubeGateway } from '@hype/core';
import { GatewayError } from '@hype/core';
import type { ChannelSnapshot, RawVideoCard } from '@hype/shared';
import type { Helpers, Innertube } from 'youtubei.js';
import { assertNotBotWalled, assertPlayable, classifyError } from './errors.js';
import { normalizeNodes } from './normalize.js';
import type { InnertubeSession } from './session.js';
import { looksLikeHiddenSubscribers, parseJoinedDate, parseSubscriberCount } from './text-parse.js';

/**
 * Motorun iptal sinyalini, enjekte edilmiş fetch'in içindeki hız yöneticisine
 * taşıyan seam. youtubei.js kendi AbortSignal'imizi ileri taşımadığı için,
 * geçerli isteğin sinyali burada paylaşılıyor.
 */
export class AbortSignalHolder {
  current: AbortSignal | undefined;
}

export interface GatewayOptions {
  session: InnertubeSession;
  clock: Clock;
  signalHolder: AbortSignalHolder;
}

/**
 * InnerTube adaptörü.
 *
 * Hız yönetimi burada DEĞİL, enjekte edilmiş fetch'in içinde: kütüphanenin
 * attığı her HTTP isteği (getInfo'nun içeride yaptığı /player + /next çifti
 * dahil) oradan geçer, dolayısıyla hiçbir kod yolu hız ayarını atlayamaz.
 */
export class InnertubeGateway implements YouTubeGateway {
  constructor(private readonly options: GatewayOptions) {}

  async fetchHomeFeed(signal: AbortSignal): Promise<RawVideoCard[]> {
    return this.guard(signal, async (yt) => {
      const feed = await yt.getHomeFeed();
      return normalizeNodes(feed.videos as unknown as Helpers.YTNode[]);
    });
  }

  /**
   * Asıl tohum kaynağı.
   *
   * Ana sayfanın aksine arama anonim oturumda sorunsuz çalışıyor ve üstelik
   * daha iyi bir tohum veriyor: `upload_date: 'week'` filtresi sonuçları zaten
   * yaş penceremize yaklaştırıyor, sorgu değiştirerek dil ve konu seçilebiliyor.
   */
  async fetchSearchFeed(query: string, signal: AbortSignal): Promise<RawVideoCard[]> {
    return this.guard(signal, async (yt) => {
      const results = await yt.search(query, { type: 'video', upload_date: 'week' });
      return normalizeNodes(results.videos as unknown as Helpers.YTNode[]);
    });
  }

  /**
   * Bir videonun öneri rafı.
   *
   * Maliyet notu: `getInfo()` içeride hem `/player` hem `/next` çağırır, yani
   * bir genişletme pahalı sınıftan iki istek harcar. Devam jetonu (sayfalama)
   * kullanılmıyor — ilk raf zaten 20+ komşu veriyor ve derinlik dallanması
   * çeşitliliği sayfalamadan daha ucuza sağlıyor.
   */
  async fetchWatchNext(videoId: string, signal: AbortSignal): Promise<WatchNextPage> {
    return this.guard(signal, async (yt) => {
      const info = await yt.getInfo(videoId);
      assertNotBotWalled(
        info.playability_status as { status?: string; reason?: string } | undefined,
      );
      return {
        cards: normalizeNodes(info.watch_next_feed as unknown as Helpers.YTNode[] | null),
        continuation: null,
      };
    });
  }

  async fetchChannelSnapshot(channelId: string, signal: AbortSignal): Promise<ChannelSnapshot> {
    return this.guard(signal, async (yt) => {
      const channel = await yt.getChannel(channelId);
      const subsText = extractSubscriberText(channel);
      const videosTab = await channel.getVideos();

      return {
        channelId,
        name: channel.metadata.title ?? '',
        handle: extractHandle(channel),
        subsApprox: parseSubscriberCount(subsText),
        subsText,
        subsHidden: looksLikeHiddenSubscribers(subsText) || subsText === null,
        // Ülke burada doldurulmuyor: ayrı istek gerektiriyor, tembel çözülüyor.
        country: null,
        recentUploads: normalizeNodes(videosTab.videos as unknown as Helpers.YTNode[]),
        fetchedAt: this.options.clock.now(),
      };
    });
  }

  /**
   * Kanalın "Hakkında" sekmesi: beyan edilen ülke + kuruluş tarihi.
   *
   * Ayrı bir istek gerektiriyor; motor onu yalnızca diğer tüm kapıları geçmiş
   * adaylar için ve kanal başına bir kez çağırır. İki alan da aynı yanıttan
   * geldiği için kanal modunun yaş bilgisi ek maliyet getirmiyor.
   *
   * youtubei.js iki farklı şekil döndürebiliyor — yeni `AboutChannel`
   * (`metadata` altında, `country` düz string) ve eski `ChannelAboutFullMetadata`
   * (kökte, `country` bir `Text` NESNESİ). Eski şekilde `typeof === 'string'`
   * kontrolü sessizce null döndürüyordu; `textOf` ikisini de okuyor.
   */
  async fetchChannelAbout(channelId: string, signal: AbortSignal): Promise<ChannelAbout> {
    return this.guard(signal, async (yt) => {
      const channel = await yt.getChannel(channelId);
      const about = await channel.getAbout();
      const raw = about as unknown as {
        country?: unknown;
        joined_date?: unknown;
        metadata?: { country?: unknown; joined_date?: unknown };
      };

      const country = textOf(raw.country ?? raw.metadata?.country);
      const joined = textOf(raw.joined_date ?? raw.metadata?.joined_date);
      return { country, joinedAtMs: parseJoinedDate(joined) };
    });
  }

  /** Yalnızca export zenginleştirmesinde çağrılır — tarama yolunda asla. */
  async fetchVideoDetails(videoId: string, signal: AbortSignal): Promise<VideoDetails> {
    return this.guard(signal, async (yt) => {
      const info = await yt.getInfo(videoId);
      assertPlayable(info.playability_status as { status?: string; reason?: string } | undefined);

      const basic = info.basic_info as {
        view_count?: unknown;
        like_count?: unknown;
        short_description?: unknown;
      };
      const views = typeof basic.view_count === 'number' ? basic.view_count : null;

      // Veri bütünlüğü bekçisi: yapısal olarak dolu ama izlenmesi tanımsız bir
      // yanıt, sessiz LOGIN_REQUIRED imzasıdır. Böyle bir veri asla skorlanmaz.
      if (views === null || !Number.isFinite(views)) {
        throw new GatewayError('login_required', `İzlenme sayısı okunamadı: ${videoId}`);
      }

      return {
        videoId,
        description: typeof basic.short_description === 'string' ? basic.short_description : null,
        publishedAt: extractPublishDate(info),
        views,
        likes: typeof basic.like_count === 'number' ? basic.like_count : null,
      };
    });
  }

  private async guard<T>(signal: AbortSignal, fn: (yt: Innertube) => Promise<T>): Promise<T> {
    this.options.signalHolder.current = signal;
    try {
      const yt = await this.options.session.get();
      return await fn(yt);
    } catch (error) {
      throw classifyError(error);
    } finally {
      this.options.signalHolder.current = undefined;
    }
  }
}

/**
 * youtubei.js metin alanları iki biçimde geliyor: düz string ya da `{ text }`
 * taşıyan bir `Text` nesnesi. İkisini tek yerde okuyoruz — eski şemada `Text`
 * gelen `country` alanı bu yüzden sessizce kayboluyordu.
 */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : null;
  const text = (value as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

/**
 * Abone sayısı metni. YouTube kanal başlığını iki farklı şemayla döndürüyor
 * (eski C4TabbedHeader ve yeni PageHeader); ikisi de denenir. Bulunamazsa null
 * döner — ek istek atarak tahmin etmeye çalışmayız, kanal zaten medyan tabanlı
 * skorla değerlendirilebilir.
 */
function extractSubscriberText(channel: unknown): string | null {
  const header = (channel as { header?: unknown }).header;
  if (header === null || header === undefined) return null;

  const legacy = (header as { subscribers?: { text?: string } }).subscribers?.text;
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;

  const rows = (header as { content?: { metadata?: { metadata_rows?: unknown[] } } }).content
    ?.metadata?.metadata_rows;
  if (!Array.isArray(rows)) return null;

  for (const row of rows) {
    const parts = (row as { metadata_parts?: unknown[] }).metadata_parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const text = (part as { text?: { text?: string } }).text?.text;
      if (typeof text === 'string' && /subscriber/i.test(text)) return text;
    }
  }
  return null;
}

function extractHandle(channel: unknown): string | null {
  const url = (channel as { metadata?: { url_canonical?: string } }).metadata?.url_canonical;
  if (typeof url !== 'string') return null;
  const match = /\/(@[\w.-]+)/.exec(url);
  return match?.[1] ?? null;
}

function extractPublishDate(info: unknown): string | null {
  const text = (info as { primary_info?: { published?: { text?: string } } }).primary_info
    ?.published?.text;
  return typeof text === 'string' && text.length > 0 ? text : null;
}
