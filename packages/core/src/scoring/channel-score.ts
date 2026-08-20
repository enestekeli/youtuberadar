import type { ChannelSnapshot, LowConfidenceReason, RawVideoCard } from '@hype/shared';
import { isFiniteNumber, median } from './robust.js';
import { VSR_SUBSCRIBER_FLOOR } from './score.js';

/**
 * Kanal istikrarı — "her videosu tutuyor mu?"
 *
 * Bu, `scoreVideo`'nun göremediği şeyi ölçüyor. Video skoru adayı KENDİ
 * kanalının medyanıyla kıyaslıyor; her videosu tutan bir kanalın medyanı zaten
 * yüksek olduğu için hiçbir videosu sivrilmiyor ve kanal 1–2x skorlarla
 * eleniyor. Yani yükselen kanallar video modunda yapısal olarak görünmez.
 *
 * Buradaki soru farklı: kanalın videolarının kaçı başarılı. Bir videonun
 * patlaması şans olabilir, onunun birden tutması olamaz.
 *
 * Tamamen saf ve BEDAVA: kanalın son yüklemeleri `ChannelSnapshot` içinde
 * zaten geliyor, ek istek yok.
 */

/**
 * Bu yaştan genç yüklemeler paydaya alınmaz.
 *
 * İzlenmesi henüz oturmamış bir video, kanalı haksız yere "isabetsiz"
 * gösterir — dün yüklenmiş videonun abone sayısını aşmamış olması kanal
 * hakkında hiçbir şey söylemez.
 */
export const CHANNEL_HIT_MIN_AGE_DAYS = 2;

/** Bu örneklemin altında istikrar iddiası zayıftır (`score.ts` ile aynı ruh). */
export const CHANNEL_LOW_CONFIDENCE_MIN_N = 8;

export interface ChannelScoreConfig {
  /** İstikrarı ölçebilmek için gereken en az kullanılabilir yükleme. */
  minChannelUploads: number;
}

export interface ChannelScore {
  /**
   * Abone sayısını aşan yüklemelerin oranı (0..1).
   *
   * BİLGİ, kapı DEĞİL: mod iki soruya indirgendi (yaş + medyan izlenme) ve bu
   * oran hiçbir şeyi elemiyor. Kartta duruyor çünkü "6 videonun 3'ü abonesini
   * aşmış" tek bir çarpandan daha çok şey anlatıyor — ama eşiği yok, yani
   * ayarlanacak bir şey de yok.
   *
   * Abone gizliyse ölçülemez; 0 döner ve `subs_hidden` işaretlenir.
   */
  hitRate: number;
  hits: number;
  /** Kullanılabilir yükleme sayısı; makbuzun paydası. */
  n: number;
  /** Ham izlenme medyanı — makbuz metni ve `channelIsHot` bunu kullanır. */
  medianViews: number;
  /** Medyan izlenme / abone. Abone gizliyse null. */
  medianVsr: number | null;
  /**
   * Kanalı temsil edecek videolar, izlenmeye göre azalan.
   *
   * Tek video değil DİZİ: en iyi aday daha önce yakalanmış olabilir ve motorun
   * bir sonrakine düşebilmesi gerekiyor. Tek değer döndürseydik "bu kanal zaten
   * görülmüş" ile "bu kanalın en iyi videosu görülmüş" ayrımını kaybederdik.
   */
  representatives: RawVideoCard[];
  lowConfidence: boolean;
  lowConfidenceReasons: LowConfidenceReason[];
}

export type ChannelScoreOutcome =
  | { kind: 'scored'; score: ChannelScore }
  | { kind: 'insufficient'; reason: 'channel_too_few_uploads' };

/**
 * Kanalın istikrarını ölçer.
 *
 * EŞİK UYGULAMIYOR — `hitRate` yeterli mi kararını motor veriyor. Bu ayrım
 * `scoreVideo`/`gateScore` ile aynı: skorlayıcı ölçer, kapı karar verir.
 * Böylece kullanıcı eşiği değiştirdiğinde skorun kendisi değişmiyor.
 */
export function scoreChannel(
  snapshot: ChannelSnapshot,
  config: ChannelScoreConfig,
): ChannelScoreOutcome {
  const usable = snapshot.recentUploads.filter(
    (u): u is RawVideoCard & { viewsApprox: number; publishedAgeDays: number } =>
      // Shorts ve canlı yayınların izlenmesi yatay videolarla aynı ölçekte
      // değil; karıştırmak isabet oranını anlamsızlaştırır.
      u.kind === 'video' &&
      isFiniteNumber(u.viewsApprox) &&
      isFiniteNumber(u.publishedAgeDays) &&
      u.publishedAgeDays >= CHANNEL_HIT_MIN_AGE_DAYS,
  );

  if (usable.length < config.minChannelUploads) {
    return { kind: 'insufficient', reason: 'channel_too_few_uploads' };
  }

  const subs =
    snapshot.subsHidden || !isFiniteNumber(snapshot.subsApprox) ? null : snapshot.subsApprox;
  const subsKnown = subs !== null && subs > 0;

  /*
   * "İsabet" = izlenme ≥ abone. Mutlak taban artık burada DEĞİL: izlenme eşiği
   * kanalın medyanına uygulanıyor ve tek bir kapı olarak duruyor. Bu oran
   * yalnızca kartta gösterilen bir bilgi.
   *
   * Abone gizliyse ölçülemez — uydurmak yerine 0 bırakılıyor ve `subs_hidden`
   * ile işaretleniyor.
   */
  const hits = subsKnown ? usable.filter((u) => u.viewsApprox >= subs).length : 0;
  const medianViews = median(usable.map((u) => u.viewsApprox)) ?? 0;

  const reasons: LowConfidenceReason[] = [];
  if (usable.length < CHANNEL_LOW_CONFIDENCE_MIN_N) reasons.push('few_uploads');
  if (!subsKnown) reasons.push('subs_hidden');

  return {
    kind: 'scored',
    score: {
      hitRate: hits / usable.length,
      hits,
      n: usable.length,
      medianViews,
      medianVsr: subsKnown ? medianViews / Math.max(subs, VSR_SUBSCRIBER_FLOOR) : null,
      // Eşitlikte daha YENİ olan öne geçsin: aynı izlenmeyi daha kısa sürede
      // toplamış video kanalı daha iyi temsil eder.
      representatives: [...usable].sort(
        (a, b) => b.viewsApprox - a.viewsApprox || a.publishedAgeDays - b.publishedAgeDays,
      ),
      lowConfidence: reasons.length > 0,
      lowConfidenceReasons: reasons,
    },
  };
}

/**
 * Kartta ve depoda kullanılacak kanal çarpanı.
 *
 * Abone gizliyse medyan VSR hesaplanamıyor ama bir değer yazmak zorundayız:
 * `videos` tablosundaki `videos_score_present` CHECK kısıtı `hype` ya da `vsr`
 * kolonlarından birinin dolu olmasını istiyor. Abone tabanına düşüyoruz —
 * `subs_hidden` bayrağı da bu sayının hangi zeminde durduğunu söylüyor.
 */
export function channelScoreValue(score: ChannelScore): number {
  return score.medianVsr ?? score.medianViews / VSR_SUBSCRIBER_FLOOR;
}
