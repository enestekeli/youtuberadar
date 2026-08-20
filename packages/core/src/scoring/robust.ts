/**
 * Dayanıklı (outlier'a dirençli) istatistik yardımcıları.
 *
 * Bu dosyanın var oluş sebebi: aradığımız şeyin kendisi bir outlier. Ortalama
 * kullanan bir taban çizgisi, kanalın önceki tek viral videosuyla yukarı çekilir
 * ve tam da bulmak istediğimiz kanalları gizler. Medyan ve MAD bundan etkilenmez.
 */

/** NaN/Infinity/null'ı tek noktada eler — InnerTube sessizce bozuk sayı döndürebilir. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Boş dizide null döner; çağıran "veri yok" ile "sıfır" arasını ayırt etmek zorunda kalır. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) return null;
  return (lower + upper) / 2;
}

/** Medyan Mutlak Sapma. Normal dağılımda standart sapmaya denk gelmesi için 1.4826 ile ölçeklenir. */
export function medianAbsoluteDeviation(values: readonly number[], center: number): number | null {
  if (values.length === 0) return null;
  const deviations = values.map((v) => Math.abs(v - center));
  const mad = median(deviations);
  return mad === null ? null : mad * 1.4826;
}

/**
 * Log-uzayında dayanıklı z-skoru. İzlenme sayıları log-normal dağıldığı için
 * ham uzayda değil log uzayında hesaplanır.
 *
 * MAD sıfırsa (tüm örnekler aynı) sapma tanımsızdır — null döner, uydurulmaz.
 */
export function robustLogZScore(value: number, samples: readonly number[]): number | null {
  if (value <= 0 || samples.length < 3) return null;
  const logs = samples.filter((s) => s > 0).map((s) => Math.log(s));
  if (logs.length < 3) return null;
  const center = median(logs);
  if (center === null) return null;
  const sigma = medianAbsoluteDeviation(logs, center);
  if (sigma === null || sigma <= 0) return null;
  return (Math.log(value) - center) / sigma;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
