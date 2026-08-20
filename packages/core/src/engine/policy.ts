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
export function pickNext(frontier: Frontier, epsilon: number, rng: Rng): FrontierEntry | null {
  if (frontier.size === 0) return null;

  if (rng.next() < epsilon) {
    const index = Math.floor(rng.next() * frontier.size);
    const random = frontier.at(Math.min(index, frontier.size - 1));
    if (random !== null) return random;
  }

  return frontier.peekBest();
}
