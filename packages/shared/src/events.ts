import { z } from 'zod';
import { CrawlConfigSchema } from './config.js';
import {
  EnginePhaseSchema,
  GateNameSchema,
  MatchSchema,
  RawVideoCardSchema,
  SkipReasonSchema,
  StopReasonSchema,
} from './domain.js';

/** Huni sayaçları — UI header şeridini ve runs.stats_json'ı besler. */
export const FunnelStatsSchema = z.object({
  scanned: z.number().int().nonnegative(),
  enqueued: z.number().int().nonnegative(),
  expanded: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  depth: z.number().int().nonnegative(),
  maxDepth: z.number().int().nonnegative(),
  frontierSize: z.number().int().nonnegative(),
  rejects: z.partialRecord(SkipReasonSchema, z.number().int().nonnegative()),
  channelCacheHits: z.number().int().nonnegative(),
  channelFetches: z.number().int().nonnegative(),
  channelNegativeHits: z.number().int().nonnegative(),
  requestsTotal: z.number().int().nonnegative(),
  requestsClassA: z.number().int().nonnegative(),
  requestsClassB: z.number().int().nonnegative(),
  http429: z.number().int().nonnegative(),
  emptyFeeds: z.number().int().nonnegative(),
  loginRequired: z.number().int().nonnegative(),
  parserWarnings: z.number().int().nonnegative(),
  channelBudgetCap: z.number().int().nonnegative(),
  requestBudgetCap: z.number().int().nonnegative(),
  startedAt: z.number().int(),
  elapsedMs: z.number().int().nonnegative(),
});
export type FunnelStats = z.infer<typeof FunnelStatsSchema>;

export const ThrottleCauseSchema = z.enum([
  'http_429',
  'login_required',
  'content_unavailable',
  'empty_feeds',
  'server_errors',
]);
export type ThrottleCause = z.infer<typeof ThrottleCauseSchema>;

/**
 * Motorun yaydığı domain olayları — motor, kalıcılık, WS ve terminalin
 * paylaştığı tek sözlük.
 */
export const DomainEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), runId: z.string(), config: CrawlConfigSchema }),
  z.object({
    type: z.literal('state_changed'),
    from: EnginePhaseSchema,
    to: EnginePhaseSchema,
    reason: z.string().optional(),
    cooldownUntil: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('seed_acquired'),
    videoId: z.string(),
    title: z.string(),
    manual: z.boolean(),
  }),
  z.object({
    type: z.literal('depth_changed'),
    depth: z.number().int(),
    maxDepth: z.number().int(),
  }),
  z.object({
    type: z.literal('node_expanded'),
    videoId: z.string(),
    depth: z.number().int(),
    cardCount: z.number().int(),
  }),
  z.object({ type: z.literal('video_scanned'), card: RawVideoCardSchema, depth: z.number().int() }),
  z.object({
    type: z.literal('video_skipped'),
    videoId: z.string(),
    title: z.string().optional(),
    stage: GateNameSchema,
    reason: SkipReasonSchema,
    detail: z.string().optional(),
    /**
     * Eleme anındaki ölçümler. Sebep tek başına geçmişe dönük filtreleme için
     * yetmez: "eşiği 3'e düşürsem hangi videolar gelirdi?" sorusunu ancak
     * izlenme ve yaş saklanırsa cevaplayabiliriz.
     */
    metrics: z
      .object({
        views: z.number().nullable(),
        ageDays: z.number().nullable(),
        vpd: z.number().nullable(),
        channelId: z.string().nullable(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('channel_resolved'),
    channelId: z.string(),
    cacheHit: z.boolean(),
    subsApprox: z.number().nullable(),
  }),
  z.object({ type: z.literal('video_matched'), match: MatchSchema }),
  z.object({ type: z.literal('stats_tick'), stats: FunnelStatsSchema }),
  z.object({
    type: z.literal('cooldown_started'),
    until: z.number().int(),
    cause: ThrottleCauseSchema,
    level: z.number().int(),
  }),
  z.object({ type: z.literal('parser_warning'), errorType: z.string(), className: z.string() }),
  z.object({ type: z.literal('engine_error'), message: z.string(), fatal: z.boolean() }),
  z.object({
    type: z.literal('run_finished'),
    runId: z.string(),
    reason: StopReasonSchema,
    stats: FunnelStatsSchema,
  }),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;

/** Her olay bu zarfla taşınır; seq süreç içinde monoton artar. */
export const EventEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
  runId: z.string().nullable(),
  event: DomainEventSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
