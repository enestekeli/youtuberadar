import { z } from 'zod';

/**
 * "Analize Gönder" köprüsünün versiyonlu zarfı. Tüketici AI ajanları bu
 * sözleşmeye güvenir; caveats alanı veri kalitesi sınırlarını açıkça taşır.
 */
export const EXPORT_SCHEMA_VERSION = 'hype-radar.video.v1';
export const EXPORT_BATCH_SCHEMA_VERSION = 'hype-radar.batch.v1';

export const ExportEnvelopeSchema = z.object({
  schema: z.literal(EXPORT_SCHEMA_VERSION),
  exported_at: z.string(),
  video: z.object({
    id: z.string(),
    url: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    duration_s: z.number().nullable(),
    published_at: z.string().nullable(),
    age_days: z.number(),
    view_count: z.number(),
    views_per_day: z.number(),
    thumbnail_url: z.string().nullable(),
  }),
  channel: z.object({
    id: z.string().nullable(),
    url: z.string().nullable(),
    title: z.string().nullable(),
    handle: z.string().nullable(),
    subscriber_count: z.number().nullable(),
    subscriber_count_is_approx: z.boolean(),
    subs_hidden: z.boolean(),
    is_hot: z.boolean(),
    baseline: z
      .object({
        stat: z.literal('median'),
        median_projected_views: z.number(),
        sample_n: z.number().int(),
        lookback_days: z.number().int(),
      })
      .nullable(),
  }),
  scores: z.object({
    type: z.enum(['hype', 'vsr']),
    hype: z.number().nullable(),
    vsr: z.number().nullable(),
    z: z.number().nullable(),
    projected_views: z.number(),
    low_confidence: z.boolean(),
    suspected_bought_traffic: z.boolean(),
    thresholds: z.object({ hype: z.number(), vsr: z.number() }),
  }),
  provenance: z.object({
    run_id: z.string(),
    depth: z.number().int(),
    seed_video_id: z.string().nullable(),
    caught_at: z.string(),
    app_version: z.string(),
    data_source: z.literal('innertube-unofficial'),
    caveats: z.array(z.string()),
  }),
});
export type ExportEnvelope = z.infer<typeof ExportEnvelopeSchema>;

export const ExportBatchSchema = z.object({
  schema: z.literal(EXPORT_BATCH_SCHEMA_VERSION),
  exported_at: z.string(),
  count: z.number().int().nonnegative(),
  items: z.array(ExportEnvelopeSchema),
});
export type ExportBatch = z.infer<typeof ExportBatchSchema>;
