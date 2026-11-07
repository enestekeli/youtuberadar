import type { CrawlConfig, PoolItem, Preset, RunDetail } from '@hype/shared';

export interface ApiProblem {
  error: string;
  message: string;
  issues?: { path: string; message: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ApiProblem,
  ) {
    super(problem.message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  /*
   * content-type YALNIZCA gövde varsa gönderilir.
   *
   * Komut uçlarımızın çoğu gövdesiz POST (durdur, duraklat, çöpe at, yeniden
   * tohumla). Bunlara "application/json" başlığı iliştirmek Fastify'ın gövdeyi
   * ayrıştırmayı denemesine ve "Body cannot be empty" ile 500 dönmesine yol
   * açıyordu: Durdur düğmesi sessizce hiçbir şey yapmıyordu.
   */
  const headers =
    init?.body === undefined
      ? init?.headers
      : { 'content-type': 'application/json', ...init?.headers };

  const response = await fetch(path, {
    ...init,
    ...(headers === undefined ? {} : { headers }),
  });

  if (!response.ok) {
    const problem = (await response.json().catch(() => ({
      error: 'unknown',
      message: `HTTP ${response.status}`,
    }))) as ApiProblem;
    throw new ApiError(response.status, problem);
  }
  return (await response.json()) as T;
}

export const api = {
  defaults: () => request<CrawlConfig>('/api/config/defaults'),

  health: () =>
    request<{
      enginePhase: string;
      activeRunId: string | null;
      resumable: string | null;
      autoRestartAt?: number | null;
      governor?: { lastHourTotal: number; lastHourClassB: number };
      pulse?: {
        limits: { hourlyTotalCap: number; hourlyClassBCap: number; intervalScale: number };
        mood: string;
        reason: string;
      };
    }>('/api/health'),

  startRun: (config: CrawlConfig, presetId?: number) =>
    request<{ runId: string }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ config, ...(presetId === undefined ? {} : { presetId }) }),
    }),

  pause: () => request<{ ok: true }>('/api/runs/current/pause', { method: 'POST' }),
  resume: () => request<{ ok: true }>('/api/runs/current/resume', { method: 'POST' }),
  stop: () => request<{ ok: true }>('/api/runs/current/stop', { method: 'POST' }),
  resumeRun: (runId: string) =>
    request<{ ok: true }>(`/api/runs/${runId}/resume`, { method: 'POST' }),

  runs: () => request<{ runs: RunDetail[] }>('/api/runs'),

  videos: (params: Record<string, string | number | boolean | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return request<{ items: PoolItem[]; nextCursor: string | null }>(`/api/videos?${query}`);
  },

  discard: (videoId: string) =>
    request<{ ok: true }>(`/api/videos/${videoId}/discard`, { method: 'POST' }),
  restore: (videoId: string) =>
    request<{ ok: true }>(`/api/videos/${videoId}/restore`, { method: 'POST' }),
  reseed: (videoId: string) =>
    request<{ ok: true; queued: boolean }>(`/api/videos/${videoId}/reseed`, { method: 'POST' }),

  exportVideos: (videoIds: string[], enrich: boolean) =>
    request<{ count: number; items: unknown[] }>('/api/export', {
      method: 'POST',
      body: JSON.stringify({ videoIds, enrich }),
    }),

  presets: () => request<{ presets: Preset[] }>('/api/presets'),
  createPreset: (name: string, config: CrawlConfig) =>
    request<Preset>('/api/presets', { method: 'POST', body: JSON.stringify({ name, config }) }),
};
