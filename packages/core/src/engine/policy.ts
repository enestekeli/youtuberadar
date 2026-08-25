import type { Rng } from '../ports/rng.js';
import type { Frontier, FrontierEntry } from './frontier.js';

/**
 * Keşif politikası — epsilon-greedy.
 *
 * %(1-ε) olasılıkla en yüksek izlenme hızına sahip komşuya dallanır: araştırma,
 * hızlı komşulara yönelmenin istek başına yakalama oranını yaklaşık ikiye
 * katladığını gösteriyor.
 *
 * %ε olasılıkla tamamen rastgele seçer. Bu dal iki işi birden yapıyor:
 * spec'in istediği "sanki tıklanmış gibi" rastgeleliği koruyor ve taramanın tek
 * bir sıcak kümenin içine gömülüp aynı çevrede dönmesini (yankı fanusu)
 * engelliyor.
 */
export function pickNext(
  frontier: Frontier,
  epsilon: number,
  rng: Rng,
  seedScans: ReadonlyMap<string, number> = new Map(),
): FrontierEntry | null {
  if (frontier.size === 0) return null;

  const entries = frontier.snapshot();
  const minimum = Math.min(...entries.map((entry) => seedScans.get(entry.seedKey) ?? 0));
  const candidates = entries.filter((entry) => (seedScans.get(entry.seedKey) ?? 0) === minimum);

  if (rng.next() < epsilon) {
    const index = Math.floor(rng.next() * candidates.length);
    const random = candidates[Math.min(index, candidates.length - 1)] ?? null;
    if (random !== null) return random;
  }

  let best: FrontierEntry | null = null;
  for (const candidate of candidates) {
    if (best === null || (candidate.vpd ?? -1) > (best.vpd ?? -1)) best = candidate;
  }
  return best;
}
