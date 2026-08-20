import { z } from 'zod';

/**
 * Feed kartlarının sınıflandırması. 'video' = yatay standart video (tek kabul edilen tür);
 * geri kalanı Kapı 0'da elenir. Bilinmeyen node tipleri 'unknown' olur — asla throw edilmez.
 */
export const VideoKindSchema = z.enum([
  'video',
  'short',
  'live',
  'upcoming',
  'mix',
  'playlist',
  'movie',
  'unknown',
]);
export type VideoKind = z.infer<typeof VideoKindSchema>;

/**
 * Adaptörün normalize ettiği feed kartı. viewsApprox/publishedAgeDays localized
 * metinden parse edilir; parse edilemezse null — ASLA sessizce 0 varsayılmaz.
 */
export const RawVideoCardSchema = z.object({
  videoId: z.string().min(1),
  title: z.string(),
  channelId: z.string().nullable(),
  channelName: z.string().nullable(),
  kind: VideoKindSchema,
  durationSec: z.number().finite().nonnegative().nullable(),
  viewsApprox: z.number().finite().nonnegative().nullable(),
  publishedAgeDays: z.number().finite().nonnegative().nullable(),
  thumbnailUrl: z.string().nullable(),
  sourceNodeType: z.string(),
});
export type RawVideoCard = z.infer<typeof RawVideoCardSchema>;

/** Kanal anlık görüntüsü — header + Videos sekmesi ilk sayfası (2 browse isteği). */
export const ChannelSnapshotSchema = z.object({
  channelId: z.string().min(1),
  name: z.string(),
  handle: z.string().nullable(),
  subsApprox: z.number().finite().nonnegative().nullable(),
  subsText: z.string().nullable(),
  subsHidden: z.boolean(),
  /**
   * Kanalın beyan ettiği ülke. Ayrı bir istek gerektirdiği için TEMBEL
   * doldurulur: yalnızca diğer tüm filtreleri geçmiş adaylar için sorulur,
   * sonra kalıcı olarak önbelleğe alınır (bir kanalın ülkesi değişmez).
   */
  country: z.string().nullable().default(null),
  recentUploads: z.array(RawVideoCardSchema),
  fetchedAt: z.number().int(),
});
export type ChannelSnapshot = z.infer<typeof ChannelSnapshotSchema>;

/** Motor faz makinesi durumları. */
export const EnginePhaseSchema = z.enum([
  'idle',
  'seeding',
  'crawling',
  'cooldown',
  'paused',
  'stopping',
  'stopped',
]);
export type EnginePhase = z.infer<typeof EnginePhaseSchema>;

export const StopReasonSchema = z.enum([
  'manual',
  'max_videos',
  'budget_exhausted',
  'fatal_error',
  'completed',
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

/** Filtre kapıları, ucuzdan pahalıya. */
export const GateNameSchema = z.enum([
  'shape',
  'prefilter',
  'channel_cache',
  'channel_fetch',
  'score',
]);
export type GateName = z.infer<typeof GateNameSchema>;

/** Eleme sebepleri — UI terminali bunları koduyla gösterir. */
export const SkipReasonSchema = z.enum([
  'shorts',
  'live',
  'upcoming',
  'mix_playlist',
  'movie',
  'unknown_kind',
  'seen',
  'age_too_old',
  'age_too_young',
  'views_too_low',
  'views_too_high',
  'vpd_too_low',
  'unparseable_metrics',
  'subs_out_of_range',
  'blocklisted',
  'channel_unavailable',
  'channel_budget_exhausted',
  'below_threshold',
  'country_mismatch',
  'country_unknown',
  /** Başlığın dili yürüyüş diliyle uyuşmuyor — üstünden yürünmedi. */
  'language_mismatch',
  'language_unknown',
  /* Kanal modu elemeleri — hepsi KANAL düzeyinde bir karar. */
  /** Kanal aranan yaştan eski (kuruluş tarihi `getAbout`'tan). */
  'channel_too_old',
  /** Kuruluş tarihi okunamadı ve `allowUnknownChannelAge` kapalı. */
  'channel_age_unknown',
  /** Kanalın medyan izlenmesi eşiğin altında. */
  'channel_views_low',
  /** Kanalın istikrarını ölçecek kadar yüklemesi yok. */
  'channel_too_few_uploads',
  'insufficient_data',
  'parse_error',
]);
export type SkipReason = z.infer<typeof SkipReasonSchema>;

/**
 * Skorun ne anlama geldiği.
 *
 * `channel` diğer ikisinden farklı bir BİRİM ölçüyor: video değil kanal.
 * Değeri kanalın medyan izlenme/abone oranı, yani `vsr` ile aynı ölçekte —
 * bu yüzden depolamada `vsr` kolonunu paylaşıyorlar ve ayrımı bu alan yapıyor.
 */
export const ScoreTypeSchema = z.enum(['hype', 'vsr', 'channel']);
export type ScoreType = z.infer<typeof ScoreTypeSchema>;

/**
 * Skorun neden temkinli okunması gerektiği.
 *
 * Tek bir `lowConfidence` bayrağı yeterli değildi: canlı veride sonuçların
 * %66'sında yanıyordu ve bu kadar sık yanan bir uyarı hiçbir şeyi ayırt etmez.
 * Sebepler ayrı ayrı taşınınca kullanıcı "taban 6 videodan kuruldu" ile
 * "video daha 1 günlük"ü birbirinden ayırabiliyor.
 */
export const LowConfidenceReasonSchema = z.enum([
  /** Taban çizgisi örneklemi ince (n < 8). */
  'thin_baseline',
  /** Kanalın normali çok düşük; küçük sayılar büyük çarpan üretir. */
  'tiny_baseline',
  /** Video henüz çok genç, izlenmesi oturmadı. */
  'young_video',
  /** Taban, alt sınıra yükseltildi — gerçek medyan daha da düşüktü. */
  'baseline_floored',
  /** Taban, adaydan SONRA yayımlanan videolardan kuruldu (kanal sık yüklüyor). */
  'newer_uploads_only',
  /** Taban çizgisi yok; skor abone oranından türetildi. */
  'no_baseline',
  /* Kanal modu sebepleri. */
  /** Kanalın istikrarı az sayıda yüklemeden okundu (n < 8). */
  'few_uploads',
  /** Kanal abone sayısını gizliyor; "izlenme > abone" bacağı ölçülemedi. */
  'subs_hidden',
  /** Kuruluş tarihi okunamadı; kanal yaşı bilinmiyor. */
  'age_unknown',
]);
export type LowConfidenceReason = z.infer<typeof LowConfidenceReasonSchema>;

/** Yakalanan video kaydı — havuzun kalıcı satırı. */
export const MatchSchema = z.object({
  videoId: z.string().min(1),
  runId: z.string().min(1),
  channelId: z.string().min(1),
  title: z.string(),
  thumbnailUrl: z.string().nullable(),
  durationSec: z.number().finite().nonnegative(),
  views: z.number().finite().nonnegative(),
  vpd: z.number().finite().nonnegative(),
  projectedViews: z.number().finite().nonnegative(),
  publishedAgeDays: z.number().finite().nonnegative(),
  scoreType: ScoreTypeSchema,
  hype: z.number().finite().positive().nullable(),
  vsr: z.number().finite().positive().nullable(),
  z: z.number().finite().nullable(),
  baselineMedian: z.number().finite().positive().nullable(),
  baselineN: z.number().int().nonnegative().nullable(),
  lowConfidence: z.boolean(),
  /** `lowConfidence` true ise en az bir sebep taşır; false ise boştur. */
  lowConfidenceReasons: z.array(LowConfidenceReasonSchema).default([]),
  channelIsHot: z.boolean(),
  suspectedBoughtTraffic: z.boolean(),
  channelName: z.string().nullable(),
  subsApprox: z.number().finite().nonnegative().nullable(),
  subsText: z.string().nullable(),
  subsHidden: z.boolean(),
  depth: z.number().int().nonnegative(),
  seedVideoId: z.string().nullable(),
  caughtAt: z.number().int(),

  /*
   * Kanal modu alanları — yalnızca `scoreType === 'channel'` iken dolu.
   *
   * `.default(null)` şart: bu alanlar eklenmeden önce yazılmış kayıtlar
   * `runs.config_json` ve `videos` satırlarında duruyor ve hâlâ parse
   * edilebilmeli.
   */
  /** Kanalın videolarından kaçının "başarılı" sayıldığı oran (0..1). */
  channelHitRate: z.number().min(0).max(1).nullable().default(null),
  /** Kanalın kuruluşundan bu yana geçen gün. Tarih okunamadıysa null. */
  channelAgeDays: z.number().finite().nonnegative().nullable().default(null),
});
export type Match = z.infer<typeof MatchSchema>;

/** Adaptörün fırlattığı tek hata türünün sınıflandırması. */
export const GatewayErrorKindSchema = z.enum([
  'throttled_soft',
  'login_required',
  'network',
  'parse_empty',
  'not_found',
]);
export type GatewayErrorKind = z.infer<typeof GatewayErrorKindSchema>;
