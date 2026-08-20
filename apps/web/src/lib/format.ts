/** Kullanıcıya gösterilen her sayı buradan geçer — tutarlılık için. */

export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}B`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Çarpan 999'da kesilir: daha büyüğü zaten ölçüm hatasıdır, sayı gibi durmasın. */
export function multiplier(value: number): string {
  if (value >= 999) return '999x+';
  return `${value.toFixed(1)}x`;
}

export function relativeAge(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} sa`;
  if (days < 30) return `${Math.round(days)} gün`;
  if (days < 365) return `${Math.round(days / 30)} ay`;
  return `${(days / 365).toFixed(1)} yıl`;
}

export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function countdown(until: number, now: number): string {
  const remaining = Math.max(0, until - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function thumbnailFor(url: string | null, videoId: string): string {
  return url ?? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
