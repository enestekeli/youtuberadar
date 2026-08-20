import type { RawVideoCard } from '@hype/shared';
import { projectViews } from './maturity.js';
import { isFiniteNumber, median } from './robust.js';

export interface BaselineParams {
  /** Taban çizgisine alınacak en fazla video sayısı (varsayılan 12). */
  baselineSize: number;
  /** Bundan eski yüklemeler yok sayılır (varsayılan 365 gün). */
  baselineLookbackDays: number;
  /** Taban çizgisinin inebileceği en düşük değer (varsayılan 400). */
  baselineFloor: number;
  /** Bu sayının altında örnekle hype hesaplanmaz (varsayılan 5). */
  baselineMinN: number;
}

export interface Baseline {
  /** Skorlamada kullanılan taban: projeksiyon medyanı, tabana yükseltilmiş. */
  value: number;
  /** Tabana yükseltilmemiş ham projeksiyon medyanı — makbuzlar ve altın yıldız için. */
  rawMedian: number;
  /** Ham (projeksiyonsuz) izlenme medyanı — kanalIsHot karşılaştırması için. */
  rawViewMedian: number;
  n: number;
  /** Kullanılan projeksiyon değerleri — kart üzerindeki sparkline bunu çizer. */
  samples: number[];
  /** Taban, floor tarafından yukarı çekildi mi? (küçük kanallarda güven işareti) */
  flooredUp: boolean;
  /**
   * Geriye dönük örneklem yetmediği için adaydan sonraki yüklemeler de
   * kullanıldı mı? Kullanıldıysa taban bir miktar şişmiş olabilir (viral video
   * kanala abone kazandırır, sonraki videolar da yükselir) — yani çarpan
   * OLDUĞUNDAN DÜŞÜK çıkar. Muhafazakâr yönde bir hata ama işaretlenir.
   */
  usedNewerUploads: boolean;
}

/**
 * Kanalın "normal" performansını hesaplar.
 *
 * Üç kural bu fonksiyonun tamamını açıklar:
 *
 * 1. MEDYAN, ortalama değil. Kanalın geçmişteki tek viral videosu ortalamayı
 *    yukarı çeker ve o kanalı bir daha asla "outlier üretiyor" olarak
 *    göremeyiz. Medyan bundan etkilenmez.
 *
 * 2. GERİYE DÖNÜK. Yalnızca adaydan önce yayımlanmış videolar sayılır. Viral
 *    bir video kanala abone kazandırır ve sonraki videoları da yükseltir;
 *    onları tabana katmak, videonun kendi başarısını kendi ölçütüne karıştırır.
 *
 * 3. YAŞ NORMALİZE. Taban da aday da 30 günlük eşdeğerine yansıtılır, böylece
 *    3 günlük aday ile 6 aylık taban aynı ölçekte kıyaslanır.
 *
 * Shorts taban çizgisinden yapısal olarak dışlanır: Shorts izlenmeleri yatay
 * videolarla aynı ölçekte değildir ve tabanı sistematik biçimde bozar.
 */
export function computeBaseline(
  candidateVideoId: string,
  candidateAgeDays: number,
  uploads: readonly RawVideoCard[],
  params: BaselineParams,
): Baseline | null {
  const usable = uploads.filter((u) => {
    if (u.videoId === candidateVideoId) return false; // aday kendi ölçütünü belirleyemez
    if (u.kind !== 'video') return false; // Shorts / canlı / premiere dışarıda
    if (!isFiniteNumber(u.viewsApprox) || !isFiniteNumber(u.publishedAgeDays)) return false;
    return u.publishedAgeDays <= params.baselineLookbackDays;
  });

  // Tercih edilen: yalnızca adaydan önce yayımlananlar. Aynı-gün videoları
  // örneklem korunsun diye dahil (yaşlar yuvarlanmış metinden geliyor).
  const backward = usable.filter((u) => (u.publishedAgeDays ?? 0) >= candidateAgeDays);

  /**
   * Canlı testte ortaya çıkan sorun: kanalın yalnızca son ~30 videosunu
   * çekiyoruz. Sık yükleyen bir kanalda bunların hepsi 12 günlük bir adaydan
   * YENİ olabilir ve geriye dönük örneklem boş kalır. O durumda ana metriği
   * tamamen kaybedip zayıf VSR yedeğine düşmek yerine, tüm yüklemeleri
   * kullanıp sonucu düşük güvenli işaretliyoruz.
   */
  const usedNewerUploads = backward.length < params.baselineMinN;
  const eligible = usedNewerUploads ? usable : backward;

  // En yeniden eskiye — kanalın güncel seviyesi, üç yıl önceki seviyesinden önemli.
  const sorted = [...eligible].sort(
    (a, b) => (a.publishedAgeDays ?? 0) - (b.publishedAgeDays ?? 0),
  );
  const window = sorted.slice(0, params.baselineSize);

  if (window.length < params.baselineMinN) return null;

  const samples: number[] = [];
  const rawViews: number[] = [];
  for (const u of window) {
    if (!isFiniteNumber(u.viewsApprox) || !isFiniteNumber(u.publishedAgeDays)) continue;
    samples.push(projectViews(u.viewsApprox, u.publishedAgeDays));
    rawViews.push(u.viewsApprox);
  }

  const rawMedian = median(samples);
  const rawViewMedian = median(rawViews);
  if (rawMedian === null || rawViewMedian === null) return null;

  return {
    value: Math.max(rawMedian, params.baselineFloor),
    rawMedian,
    rawViewMedian,
    n: samples.length,
    samples,
    flooredUp: rawMedian < params.baselineFloor,
    usedNewerUploads,
  };
}
