import { z } from 'zod';
import { EnginePhaseSchema, LowConfidenceReasonSchema } from './domain.js';
import { FunnelStatsSchema } from './events.js';

/**
 * WS kablo protokolü. Sunucu→istemci tek yönlü olay akışı; komutlar REST'te.
 * Uyumsuz değişiklikte PROTOCOL_VERSION artırılır — hello el sıkışmasında
 * eşleşmezse UI açık bir "yeniden derle" bandı gösterir.
 */
/**
 * 2: `PoolScore` ayrık birleşimine `channel` varyantı eklendi. Eski bir istemci
 * bilinmeyen `type` değerini ayrıştıramaz, o yüzden sürüm artırıldı — el
 * sıkışması uyuşmazsa arayüz "yeniden derle" bandını gösterir.
 */
export const PROTOCOL_VERSION = 2;

export const LogLevelSchema = z.enum([
  'seed',
  'visit',
  'skip',
  'match',
  'channel',
  'rate',
  'info',
  'warn',
  'error',
]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogLineSchema = z.object({
  id: z.string(),
  ts: z.number().int(),
  level: LogLevelSchema,
  msg: z.string(),
  videoId: z.string().optional(),
  channelId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

/** Havuz kartı — progressive hydration: önce pending, kanal çözülünce skor. */
export const PoolScoreSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pending') }),
  z.object({
    type: z.literal('hype'),
    value: z.number().finite().positive(),
    z: z.number().finite().nullable(),
    lowConfidence: z.boolean(),
    /** Sebepler; eski kayıtlarda boş kalabilir (o zaman sütun yoktu). */
    lowConfidenceReasons: z.array(LowConfidenceReasonSchema).default([]),
  }),
  z.object({
    type: z.literal('vsr'),
    value: z.number().finite().positive(),
    lowConfidence: z.boolean(),
    lowConfidenceReasons: z.array(LowConfidenceReasonSchema).default([]),
  }),
  /**
   * Kanal modu skoru — bulunan şey video değil KANAL.
   *
   * `value` kanalın medyan izlenme/abone oranı (vsr ile aynı ölçek), ama asıl
   * iddia `hitRate`: videolarının kaçının abonesini aştığı. Kart bu ikisini
   * birlikte gösteriyor, çünkü tek başına yüksek bir çarpan "bir videosu
   * patlamış" da olabilir; asıl aranan İSTİKRAR.
   */
  z.object({
    type: z.literal('channel'),
    value: z.number().finite().positive(),
    hitRate: z.number().min(0).max(1),
    /** Kuruluşundan bu yana geçen gün; tarih okunamadıysa null. */
    channelAgeDays: z.number().finite().nonnegative().nullable(),
    /** İstikrarın kaç yüklemeden okunduğu — makbuzun paydası. */
    uploads: z.number().int().nonnegative(),
    lowConfidence: z.boolean(),
    lowConfidenceReasons: z.array(LowConfidenceReasonSchema).default([]),
  }),
]);
export type PoolScore = z.infer<typeof PoolScoreSchema>;

export const PoolItemSchema = z.object({
  videoId: z.string().min(1),
  runId: z.string().min(1),
  title: z.string(),
  thumbnailUrl: z.string().nullable(),
  durationSec: z.number().finite().nonnegative().nullable(),
  channelId: z.string().nullable(),
  channelName: z.string().nullable(),
  subsText: z.string().nullable(),
  /** Sayısal abone: arayüzün havuzu abone aralığına göre süzebilmesi için. */
  subsApprox: z.number().finite().nonnegative().nullable(),
  views: z.number().finite().nonnegative(),
  ageDays: z.number().finite().nonnegative(),
  vpd: z.number().finite().nonnegative(),
  score: PoolScoreSchema,
  receipts: z
    .object({
      baselineN: z.number().int().nonnegative(),
      baselineMedian: z.number().finite().positive(),
      baselineSamples: z.array(z.number().finite().nonnegative()),
    })
    .nullable(),
  channelIsHot: z.boolean(),
  suspectedBoughtTraffic: z.boolean(),
  discarded: z.boolean(),
  depth: z.number().int().nonnegative(),
  caughtAt: z.number().int().nullable(),
});
export type PoolItem = z.infer<typeof PoolItemSchema>;

export const RunSummarySchema = z.object({
  runId: z.string(),
  status: EnginePhaseSchema,
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  stopReason: z.string().nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

const envelopeFields = {
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
} as const;

export const SnapshotStateSchema = z.object({
  epochId: z.string(),
  seq: z.number().int().nonnegative(),
  status: EnginePhaseSchema,
  activeRun: RunSummarySchema.nullable(),
  cooldownUntil: z.number().int().nullable(),
  stats: FunnelStatsSchema.nullable(),
  pool: z.array(PoolItemSchema),
  logTail: z.array(LogLineSchema),
});
export type SnapshotState = z.infer<typeof SnapshotStateSchema>;

export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelopeFields,
    type: z.literal('hello'),
    epochId: z.string(),
    protocolVersion: z.number().int(),
    status: EnginePhaseSchema,
    activeRunId: z.string().nullable(),
  }),
  z.object({ ...envelopeFields, type: z.literal('snapshot'), state: SnapshotStateSchema }),
  z.object({ ...envelopeFields, type: z.literal('resumeOk'), replayed: z.number().int() }),
  z.object({
    ...envelopeFields,
    type: z.literal('run:status'),
    runId: z.string().nullable(),
    state: EnginePhaseSchema,
    detail: z.string().optional(),
    cooldownUntil: z.number().int().optional(),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal('stats'),
    runId: z.string(),
    stats: FunnelStatsSchema,
  }),
  z.object({
    ...envelopeFields,
    type: z.literal('log'),
    runId: z.string().nullable(),
    lines: z.array(LogLineSchema),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal('pool:add'),
    runId: z.string(),
    item: PoolItemSchema,
  }),
  z.object({
    ...envelopeFields,
    type: z.literal('pool:update'),
    runId: z.string(),
    videoId: z.string(),
    patch: PoolItemSchema.partial(),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal('pool:remove'),
    runId: z.string(),
    videoId: z.string(),
    reason: z.enum(['discarded', 'failed_gate', 'restored_elsewhere']),
  }),
  z.object({ ...envelopeFields, type: z.literal('pong') }),
  z.object({ ...envelopeFields, type: z.literal('fatal'), code: z.string(), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export const ClientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resume'),
    epochId: z.string().nullable(),
    fromSeq: z.number().int().nonnegative().nullable(),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/** Skor rozeti ısı kademeleri — sektör standardı kesme noktaları. */
export function hypeTier(value: number): 'mega' | 'hot' | 'warm' | 'neutral' {
  if (value >= 10) return 'mega';
  if (value >= 5) return 'hot';
  if (value >= 2) return 'warm';
  return 'neutral';
}
