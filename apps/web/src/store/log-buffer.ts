import type { LogLevel, LogLine } from '@hype/shared';

export const LOG_CAPACITY = 20_000;

/**
 * Log satırları React state'inin DIŞINDA, modül düzeyinde bir halka tamponda.
 *
 * Bileşenler yalnızca bir sürüm sayacına abone olur; asıl veriyi sanallaştırıcı
 * indeksle okur.
 *
 * PERFORMANS NOTU — burası ölçümle şekillendi. İlk sürümde her log paketinde
 * (saniyede ~10 kez) tamponun tamamı iki kez taranıyordu: bir kez seviye
 * sayaçları için, bir kez filtre indeksi için. 20 bin satırda bu saniyede
 * 400 bin işlem demekti ve tarayıcı sekmesini kilitliyordu (sunucu bu sırada
 * %1 CPU kullanıyordu — darboğaz tamamen arayüzdeydi). Üç düzeltme:
 *
 *   1. Seviye sayaçları artımlı tutuluyor: satır başına O(1).
 *   2. Filtre yokken indeks dizisi HİÇ kurulmuyor (varsayılan durum).
 *   3. Sürüm bildirimi animasyon karesinde birleştiriliyor: arka arkaya gelen
 *      paketler tek bir render'a düşüyor.
 */
class LogBuffer {
  private lines: LogLine[] = [];
  private version = 0;
  private listeners = new Set<() => void>();
  private levelCounts: Partial<Record<LogLevel, number>> = {};
  private notifyScheduled = false;

  append(incoming: readonly LogLine[]): void {
    if (incoming.length === 0) return;

    for (const line of incoming) {
      this.lines.push(line);
      this.levelCounts[line.level] = (this.levelCounts[line.level] ?? 0) + 1;
    }

    const overflow = this.lines.length - LOG_CAPACITY;
    if (overflow > 0) {
      // Düşen satırların sayaçları da düşürülür; aksi hâlde sayılar şişerdi.
      for (const dropped of this.lines.splice(0, overflow)) {
        const current = this.levelCounts[dropped.level];
        if (current !== undefined) this.levelCounts[dropped.level] = current - 1;
      }
    }
    this.bump();
  }

  replace(incoming: readonly LogLine[]): void {
    this.lines = [...incoming];
    this.levelCounts = {};
    for (const line of this.lines) {
      this.levelCounts[line.level] = (this.levelCounts[line.level] ?? 0) + 1;
    }
    this.bump();
  }

  clear(): void {
    this.lines = [];
    this.levelCounts = {};
    this.bump();
  }

  get size(): number {
    return this.lines.length;
  }

  at(index: number): LogLine | undefined {
    return this.lines[index];
  }

  /**
   * Filtreye uyan satırların indeksleri.
   *
   * Filtre yoksa `null` döner — çağıran bunu "tamponun kendisini kullan" diye
   * okur ve 20 bin elemanlık bir dizi kurma maliyetinden kurtulur. Varsayılan
   * durum tam olarak budur.
   */
  indicesMatching(levels: Set<LogLevel> | null, search: string): number[] | null {
    const needle = search.trim().toLowerCase();
    if (levels === null && needle.length === 0) return null;

    const indices: number[] = [];
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (line === undefined) continue;
      if (levels !== null && !levels.has(line.level)) continue;
      if (needle.length > 0 && !line.msg.toLowerCase().includes(needle)) continue;
      indices.push(i);
    }
    return indices;
  }

  /** Artımlı tutulan seviye sayaçları — tarama gerektirmez. */
  counts(): Partial<Record<LogLevel, number>> {
    return this.levelCounts;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  /** Arka arkaya gelen paketleri tek render'da birleştirir. */
  private bump(): void {
    this.version += 1;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    requestAnimationFrame(() => {
      this.notifyScheduled = false;
      for (const listener of this.listeners) listener();
    });
  }
}

export const logBuffer = new LogBuffer();
