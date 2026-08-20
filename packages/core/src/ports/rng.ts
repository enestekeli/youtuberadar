/**
 * Rastgelelik de enjekte edilir: keşif politikasının epsilon dalı ve tohum
 * seçimi tohumlanmış bir üreteçle deterministik hâle gelir, böylece
 * "1000 videoluk tarama şu outlier'ı yakalar" testi her koşuda aynı sonucu verir.
 */
export interface Rng {
  /** [0, 1) aralığında. */
  next(): number;
}

/** mulberry32 — küçük, hızlı, testler için yeterince iyi dağılımlı. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export const systemRng: Rng = { next: () => Math.random() };

/** Diziden rastgele bir eleman — boş dizide null. */
export function pickRandom<T>(items: readonly T[], rng: Rng): T | null {
  if (items.length === 0) return null;
  const index = Math.floor(rng.next() * items.length);
  return items[Math.min(index, items.length - 1)] ?? null;
}
