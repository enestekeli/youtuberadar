import type { ChannelSnapshot, GatewayErrorKind, RawVideoCard, SearchFilter } from '@hype/shared';

export interface WatchNextPage {
  cards: RawVideoCard[];
  /** Devam jetonu; null ise öneri rafının sonu. */
  continuation: string | null;
}

/**
 * Kanalın "Hakkında" sekmesinden okunan alanlar.
 *
 * İkisi de tek istekten geliyor. `joinedAtMs`, kanal modunun "kısa sürede
 * açılmış" iddiasının TEK güvenilir kaynağı: kanalın son yüklemelerinin yaşına
 * bakmak yanıltıcı olurdu, çünkü yalnızca ilk sayfayı (~30 video) görüyoruz —
 * çok yükleyen eski bir kanal da tamamen genç videolarla görünür.
 */
export interface ChannelAbout {
  country: string | null;
  /** Kuruluş tarihi (epoch ms). Metin okunamadıysa null — asla tahmin edilmez. */
  joinedAtMs: number | null;
}

/** Yalnızca export zenginleştirmesinde çekilen pahalı alanlar. */
export interface VideoDetails {
  videoId: string;
  description: string | null;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
}

/**
 * Motorun gördüğü TEK hata türü. youtubei.js'in kendi hata sınıfları, HTTP
 * durumları ve "yapısal olarak dolu ama anlamsal olarak boş" yanıtlar adaptörde
 * bu beş kategoriye indirgenir — böylece cooldown mantığı ağa hiç dokunmadan
 * test edilebilir.
 */
export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError;
}

/**
 * Hexagonun dikişi. `@hype/core` YouTube'u yalnızca bu arayüz üzerinden bilir;
 * youtubei.js'e ait hiçbir tip bu sınırı geçemez.
 */
export interface YouTubeGateway {
  /**
   * browse FEwhat_to_watch. 1 ucuz istek.
   *
   * Anonim oturumda çoğu zaman video DÖNDÜRMEZ — YouTube "giriş yap" kartı
   * gösterir. Yine de önce denenir; kullanıcı ileride oturum eklerse bedava
   * kazanç olur. Boş dönerse motor arama tohumlarına geçer.
   */
  fetchHomeFeed(signal: AbortSignal): Promise<RawVideoCard[]>;
  /** Asıl tohum kaynağı: arama. Anonim çalışır, dil ve konu seçilebilir. 1 ucuz istek. */
  fetchSearchFeed(
    query: string,
    signal: AbortSignal,
    filter?: SearchFilter,
  ): Promise<RawVideoCard[]>;
  /** next — öneri grafının kenarları. 1 pahalı istek. */
  fetchWatchNext(videoId: string, signal: AbortSignal): Promise<WatchNextPage>;
  /** Kanal başlığı + Videos sekmesi. 2 ucuz istek, tek çağrının arkasında. */
  fetchChannelSnapshot(channelId: string, signal: AbortSignal): Promise<ChannelSnapshot>;
  /**
   * Kanalın "Hakkında" sekmesi. 1 ucuz istek, yalnızca diğer tüm kapıları
   * geçmiş adaylar için ve kanal başına bir kez.
   *
   * Ülke ve kuruluş tarihi AYNI yanıttan geliyor: ülke filtresi bunu zaten
   * çağırıyordu, kanal modunun yaş bilgisi bu yüzden ek maliyet getirmiyor.
   */
  fetchChannelAbout(channelId: string, signal: AbortSignal): Promise<ChannelAbout>;
  /** player — tarama sırasında ASLA çağrılmaz, yalnızca export anında. */
  fetchVideoDetails(videoId: string, signal: AbortSignal): Promise<VideoDetails>;
}
