/**
 * Tier 0 — izlenme hızı (views per day).
 *
 * Feed kartından bedava hesaplanır; hiçbir ek istek gerektirmez. İki yerde
 * kullanılır: Kapı 1'in ucuz ön filtresi ve frontier sıralaması (yüksek hızlı
 * komşulara dallanmak yakalama oranını istek başına yaklaşık ikiye katlar).
 *
 * ASLA kullanıcıya "hype çarpanı" olarak gösterilmez — kanalın kendi ölçeğine
 * göre normalize edilmemiştir, o iş Tier 1'in işidir.
 */
export function viewsPerDay(views: number, ageDays: number): number {
  // Yarım günlük taban: birkaç saatlik videoların hızını sonsuza taşımamak için.
  return views / Math.max(ageDays, 0.5);
}
