export interface FrontierEntry {
  videoId: string;
  depth: number;
  /** İzlenme/gün — keşif politikasının sıralama anahtarı. Okunamadıysa null. */
  vpd: number | null;
  parentVideoId: string | null;
  addedSeq: number;
}

export const DEFAULT_FRONTIER_CAPACITY = 500;

/**
 * BFS kuyruğu. Sınırlı boyutlu: dolduğunda en düşük değerli düğüm atılır,
 * böylece uzun bir tarama belleği şişirmez ve kuyruk hep en umutlu adaylardan
 * oluşur.
 *
 * Yinelenen videoId'ler için Bloom filtresi yerine düz `Set` kullanılıyor:
 * oturum başına en fazla birkaç bin video var, `Set` kesin sonuç veriyor ve
 * yanlış-pozitif riski taşımıyor.
 */
export class Frontier {
  private entries: FrontierEntry[] = [];
  private ids = new Set<string>();
  private seq = 0;

  constructor(private readonly capacity: number = DEFAULT_FRONTIER_CAPACITY) {}

  get size(): number {
    return this.entries.length;
  }

  has(videoId: string): boolean {
    return this.ids.has(videoId);
  }

  add(entry: Omit<FrontierEntry, 'addedSeq'>): boolean {
    if (this.ids.has(entry.videoId)) return false;

    const full: FrontierEntry = { ...entry, addedSeq: this.seq++ };
    this.entries.push(full);
    this.ids.add(full.videoId);

    if (this.entries.length > this.capacity) {
      const victim = this.weakest();
      if (victim !== null) {
        this.remove(victim.videoId);
        // Eklenen düğümün kendisi elendiyse ekleme başarısız sayılır.
        if (victim.videoId === full.videoId) return false;
      }
    }
    return true;
  }

  /** En yüksek izlenme hızına sahip düğüm. Hız bilinmeyenler en sona düşer. */
  peekBest(): FrontierEntry | null {
    let best: FrontierEntry | null = null;
    for (const entry of this.entries) {
      if (best === null || score(entry) > score(best)) best = entry;
    }
    return best;
  }

  at(index: number): FrontierEntry | null {
    return this.entries[index] ?? null;
  }

  remove(videoId: string): FrontierEntry | null {
    const index = this.entries.findIndex((e) => e.videoId === videoId);
    if (index === -1) return null;
    const [removed] = this.entries.splice(index, 1);
    if (removed === undefined) return null;
    this.ids.delete(videoId);
    return removed;
  }

  snapshot(): FrontierEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  restore(entries: readonly FrontierEntry[]): void {
    this.entries = entries.map((e) => ({ ...e }));
    this.ids = new Set(this.entries.map((e) => e.videoId));
    this.seq = this.entries.reduce((max, e) => Math.max(max, e.addedSeq + 1), 0);
  }

  clear(): void {
    this.entries = [];
    this.ids.clear();
  }

  private weakest(): FrontierEntry | null {
    let worst: FrontierEntry | null = null;
    for (const entry of this.entries) {
      if (worst === null || score(entry) < score(worst)) worst = entry;
    }
    return worst;
  }
}

/** Hızı okunamayan düğümler en düşük önceliği alır ama tamamen dışlanmaz. */
function score(entry: FrontierEntry): number {
  return entry.vpd ?? -1;
}
