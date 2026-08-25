import { z } from 'zod';
import { CrawlConfigSchema } from './config.js';
import { EnginePhaseSchema, ScoreTypeSchema } from './domain.js';
import { FunnelStatsSchema } from './events.js';

/** POST /api/runs gövdesi — kısmi config kabul eder, varsayılanlarla doldurur. */
export const StartRunRequestSchema = z.object({
  config: CrawlConfigSchema,
  presetId: z.number().int().optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const RunDetailSchema = z.object({
  runId: z.string(),
  status: EnginePhaseSchema,
  config: CrawlConfigSchema,
  stats: FunnelStatsSchema.nullable(),
  stopReason: z.string().nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

/** GET /api/videos sorgusu — havuz üzerinde sunucu tarafı SQL filtreleri. */
export const VideosQuerySchema = z.object({
  runId: z.string().optional(),
  status: z.enum(['pooled', 'discarded', 'exported', 'all']).default('pooled'),
  scoreType: z.union([ScoreTypeSchema, z.literal('all')]).default('all'),
  minHype: z.coerce.number().min(0).optional(),
  minViews: z.coerce.number().int().min(0).optional(),
  maxAgeDays: z.coerce.number().min(0).optional(),
  goldStarOnly: z.coerce.boolean().default(false),
  hideLowConfidence: z.coerce.boolean().default(false),
  q: z.string().optional(),
  sort: z.enum(['hype', 'z', 'views', 'vpd', 'date', 'subs']).default('hype'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export type VideosQuery = z.infer<typeof VideosQuerySchema>;

export const ExportRequestSchema = z.object({
  videoIds: z.array(z.string().min(1)).min(1).max(500),
  destination: z.enum(['payload', 'file', 'webhook']).default('payload'),
  /**
   * Açıklama, kesin tarih ve beğeni sayısı için video başına bir pahalı istek.
   * Toplu export'ta kapatmak, istek bütçesini korur.
   */
  enrich: z.boolean().default(true),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export const PresetSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(80),
  description: z.string().nullable(),
  config: CrawlConfigSchema,
  builtin: z.boolean(),
});
export type Preset = z.infer<typeof PresetSchema>;

export const UpsertPresetSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullish(),
  config: CrawlConfigSchema,
});
export type UpsertPreset = z.infer<typeof UpsertPresetSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  dbOk: z.boolean(),
  sessionReady: z.boolean(),
  enginePhase: EnginePhaseSchema,
  activeRunId: z.string().nullable(),
  version: z.string(),
  governor: z.object({
    lastHourTotal: z.number().int().nonnegative(),
    lastHourClassB: z.number().int().nonnegative(),
    tokens: z.number().nonnegative(),
  }),
  resumable: z.string().nullable(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
