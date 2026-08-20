import type { ChannelSnapshot } from '@hype/shared';

export type ChannelVerdict =
  | 'unknown'
  | 'in_range'
  | 'out_of_range'
  | 'blocklisted'
  | 'unavailable';

export interface CachedChannel {
  channelId: string;
  snapshot: ChannelSnapshot | null;
  /**
   * Anlık görüntü bayatlamış olsa bile bilinen abone sayısı.
   *
   * Verdikt önbelleği bunun için var: kullanıcı abone aralığını değiştirdiğinde
   * eski "aralık dışı" kararını körü körüne uygulamak yerine, saklanan sayıyı
   * güncel ayarla yeniden değerlendiriyoruz.
   */
  subsApprox: number | null;
  /** Kalıcı: bir kanalın ülkesi değişmez, bir kez sorulur. */
  country: string | null;
  /**
   * Kanalın kuruluş tarihi (epoch ms) — kalıcı, ülke gibi bir kez sorulur.
   *
   * Bu bir VERİ, karar DEĞİL. Yaş asla `verdict`'e yazılmamalı: verdikt kalıcı
   * saklanıyor ve kullanıcı yaş eşiğini gevşettiğinde eski karar yapışırdı.
   * `subsApprox` ile aynı ilke — sayıyı saklıyoruz, kararı her seferinde
   * güncel ayardan türetiyoruz.
   */
  joinedAt: number | null;
  verdict: ChannelVerdict;
  /** null = kalıcı (blocklist). Geçmiş bir zaman = süresi dolmuş. */
  verdictExpiresAt: number | null;
  snapshotFetchedAt: number | null;
}

/**
 * Kanal önbelleği. Sistemin tek pahalı kaynağı kanal isteğidir; bu önbellek
 * öneri grafının aynı büyük kanalları defalarca göstermesini bedava karşılar.
 */
export interface ChannelCacheRepo {
  get(channelId: string): Promise<CachedChannel | null>;
  putSnapshot(
    snapshot: ChannelSnapshot,
    verdict: ChannelVerdict,
    verdictExpiresAt: number | null,
    fetchedAt: number,
  ): Promise<void>;
  putVerdict(
    channelId: string,
    verdict: ChannelVerdict,
    verdictExpiresAt: number | null,
  ): Promise<void>;
  /**
   * "Hakkında" isteğinden öğrenilenleri kalıcılaştırır — ikisi de değişmeyen
   * bilgiler, kanal başına bir kez sorulur.
   *
   * `null` gelen bir alan, daha önce ÖĞRENİLMİŞ bir değeri EZMEZ: YouTube'un
   * şeması değiştiğinde ya da tek bir yanıt eksik geldiğinde bildiğimiz doğruyu
   * kaybetmek, hiç öğrenmemekten kötüdür.
   */
  putAbout(channelId: string, country: string | null, joinedAt: number | null): Promise<void>;
}

/**
 * Havuza girmiş ya da kullanıcı tarafından çöpe atılmış videolar. Aynı
 * evergreen outlier her taramada havuzu doldurmasın diye.
 *
 * Dikkat: elenen videolar buraya YAZILMAZ. Kullanıcı abone aralığını ya da
 * eşiği değiştirdiğinde daha önce elenmiş bir videonun yeniden değerlendirilmesi
 * gerekir; onları kalıcı olarak işaretlemek ayarları anlamsızlaştırırdı.
 */
export interface SeenRepo {
  has(videoId: string): Promise<boolean>;
  add(videoId: string, runId: string): Promise<void>;
}

/**
 * Uygulama düzeyi küçük kalıcı değerler: misafir kimliği (visitorData), şema
 * sürümü, mola bitiş zamanı. Yeniden başlatmanın ceza süresini sıfırlamaması
 * bu depoya bağlı.
 */
export interface KvRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export const KV_VISITOR_DATA = 'visitor_data';
export const KV_VISITOR_DATA_CREATED_AT = 'visitor_data_created_at';
export const KV_COOLDOWN_UNTIL = 'cooldown_until';
