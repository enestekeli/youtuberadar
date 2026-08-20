/**
 * Yaş normalizasyonu.
 *
 * Piyasadaki outlier araçlarının belgelenmiş zayıf noktası: 2 günlük bir videoyu
 * kanalın 3 aylık videolarıyla ham izlenme üzerinden kıyaslamak. Yeni video
 * haksız yere düşük skor alır, eski video haksız yere yüksek.
 *
 * Çözüm: her videonun izlenmesini "30 günde ulaşacağı tahmini değere" yansıtmak.
 * İzlenme birikimi logaritmik ilerler — ilk günler dik, sonra düzleşir.
 *
 *   m(t) = ln(1 + t/τ) / ln(1 + T/τ)     τ = 3 gün, T = 30 gün
 *
 * m(30) = 1 (tanım gereği), m(3) ≈ 0.29, m(1) ≈ 0.12, m(365) ≈ 2.0.
 */
export const MATURITY_TAU_DAYS = 3;
export const MATURITY_HORIZON_DAYS = 30;

/**
 * Olgunluk tabanı. Bu olmadan 6 saatlik bir video 8 katına projeksiyonlanır ve
 * gürültü, gerçek hit'lerin arasına sızar. Taban, çok genç videoların
 * projeksiyonunu makul bir tavanla sınırlar (Kapı 1'deki 18 saatlik minimum yaş
 * filtresiyle birlikte çalışır).
 */
export const MATURITY_FLOOR = 0.15;

/**
 * Bir videonun 30 günlük potansiyeline göre t günde gerçekleşmiş oranı.
 *
 * 30 günden yaşlı videolarda 1'i AŞAR ve aşmalıdır. Eğri daha önce 30 günde
 * kelepçeleniyordu: 300 günlük bir video, üç yüz günde biriktirdiği izlenmeyi
 * "30 günlük değeri" olarak sayıyor ve bir aylık videoyla aynı kefeye konuyordu.
 * Ölçülen sonuç, yaşla orantılı sistematik şişmeydi — havuzun %43'ünde ortalama
 * 1.35x, 334 günlük videolarda 2.0x. Kullanıcı yaş filtresini kaldırdığında
 * eski videolar taze olanları haksız yere eziyordu.
 *
 * Alt taban (0.15) duruyor: çok genç videoların projeksiyonu sınırsız büyümesin.
 * Üstte tavan yok — logaritmik büyüme zaten kendini frenliyor (m(1 yıl) ≈ 2.0,
 * m(10 yıl) ≈ 3.0) ve taban çizgisi örneklemi `baselineLookbackDays` ile sınırlı.
 */
export function maturity(ageDays: number): number {
  const t = Math.max(ageDays, 0);
  const raw =
    Math.log1p(t / MATURITY_TAU_DAYS) / Math.log1p(MATURITY_HORIZON_DAYS / MATURITY_TAU_DAYS);
  return Math.max(raw, MATURITY_FLOOR);
}

/**
 * İzlenmeyi 30 günlük eşdeğerine yansıtır — her iki yönde de.
 *
 * Genç video YUKARI (henüz birikmemiş izlenme tahmin edilir), 30 günden yaşlı
 * video AŞAĞI (30. gündeki değeri tahmin edilir) çekilir. Aday ve taban çizgisi
 * aynı dönüşümden geçtiği için çarpan, yaşı ne olursa olsun aynı ölçekte kalır.
 */
export function projectViews(views: number, ageDays: number): number {
  return views / maturity(ageDays);
}
