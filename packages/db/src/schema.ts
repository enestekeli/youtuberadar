import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Tek kullanıcılı yerel araç için SQLite şeması.
 *
 * Tasarımın iki taşıyıcı kararı:
 *
 * 1. `videos.status` bir DURUM, bir silme değil. Kullanıcı bir videoyu çöpe
 *    attığında satır kalır; sonraki taramalarda o video bir daha havuza
 *    girmesin diye. DELETE etseydik aynı video her taramada geri gelirdi.
 *
 * 2. `hype` ve `vsr` AYRI kolonlar, aralarında bir `score_type` ayracı var.
 *    Medyan-çarpanıyla abone-oranını tek kolonda sıralamak arayüzü yalancı
 *    yapar; şema düzeyinde ayırmak bunu imkânsız kılıyor.
 */

/** Uygulama düzeyi küçük kalıcı değerler: misafir kimliği, mola bitişi. */
export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const presets = sqliteTable('presets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description'),
  configJson: text('config_json').notNull(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Tarama oturumları. `config_json` başlangıçtaki ayarların ANLIK GÖRÜNTÜSÜDÜR:
 * preset sonradan değiştirilse bile geçmiş oturumlar yeniden üretilebilir kalır.
 *
 * `frontier_snapshot_json` çökme sonrası devam içindir — kuyruk, bütçe ve
 * görülenler birlikte saklanır, böylece yeniden başlatma harcanan bütçeyi
 * sıfırlamaz.
 */
export const runs = sqliteTable(
  'runs',
  {
    runId: text('run_id').primaryKey(),
    status: text('status').notNull(),
    configJson: text('config_json').notNull(),
    statsJson: text('stats_json'),
    stopReason: text('stop_reason'),
    frontierSnapshotJson: text('frontier_snapshot_json'),
    presetId: integer('preset_id'),
    appVersion: text('app_version').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [index('idx_runs_started').on(t.startedAt), index('idx_runs_status').on(t.status)],
);

/**
 * Kanal önbelleği — sistemin tek pahalı kaynağını koruyan katman.
 *
 * `verdict` + `verdict_expires_at` ikilisi negatif önbelleği taşır: öneri grafı
 * aynı dev kanalları sürekli gösterir, onları 7 gün boyunca bedava elemek
 * istek bütçesinin en büyük tasarrufudur.
 */
export const channels = sqliteTable(
  'channels',
  {
    channelId: text('channel_id').primaryKey(),
    name: text('name').notNull().default(''),
    handle: text('handle'),
    subsApprox: integer('subs_approx'),
    subsText: text('subs_text'),
    subsHidden: integer('subs_hidden', { mode: 'boolean' }).notNull().default(false),
    /** Kalıcı: bir kanalın ülkesi değişmez, bir kez sorulur. */
    country: text('country'),
    /**
     * Kanalın kuruluş tarihi (epoch ms), "Hakkında" isteğinden.
     *
     * VERİ, karar değil: yaş eşiği `verdict`'e ASLA yazılmamalı — verdikt
     * kalıcı saklanıyor ve kullanıcı eşiği gevşettiğinde eski karar yapışırdı.
     */
    joinedAt: integer('joined_at'),
    uploadsJson: text('uploads_json'),
    snapshotFetchedAt: integer('snapshot_fetched_at'),
    verdict: text('verdict').notNull().default('unknown'),
    /** null = kalıcı (kara liste). */
    verdictExpiresAt: integer('verdict_expires_at'),
    fetchErrorCount: integer('fetch_error_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_channels_verdict').on(t.verdict, t.verdictExpiresAt),
    index('idx_channels_updated').on(t.updatedAt),
  ],
);

/** Havuz: yalnızca YAKALANAN videolar. Elenenler burada değil, gözlemlerde. */
export const videos = sqliteTable(
  'videos',
  {
    videoId: text('video_id').primaryKey(),
    runId: text('run_id').notNull(),
    channelId: text('channel_id').notNull(),
    title: text('title').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    durationSec: integer('duration_sec').notNull(),
    views: integer('views').notNull(),
    vpd: real('vpd').notNull(),
    projectedViews: real('projected_views').notNull(),
    publishedAgeDays: real('published_age_days').notNull(),

    scoreType: text('score_type').notNull(),
    hype: real('hype'),
    vsr: real('vsr'),
    z: real('z'),
    baselineMedian: real('baseline_median'),
    baselineN: integer('baseline_n'),
    baselineSamplesJson: text('baseline_samples_json'),
    lowConfidence: integer('low_confidence', { mode: 'boolean' }).notNull().default(false),
    /** Bayrağın sebepleri (JSON dizi). Eski satırlarda null — sebep kaydedilmiyordu. */
    lowConfidenceReasonsJson: text('low_confidence_reasons_json'),
    /*
     * Kanal modu alanları — yalnızca `score_type = 'channel'` satırlarında dolu.
     *
     * Kanal çarpanının kendisi `vsr` kolonunda duruyor: `videos_score_present`
     * CHECK kısıtı hype ya da vsr'den birinin dolu olmasını istiyor ve SQLite'ta
     * CHECK değiştirmek tabloyu yeniden inşa etmek demek. Medyan-VSR zaten
     * izlenme/abone birimi, yani kolonu paylaşmaları dürüst; ayrımı `score_type`
     * yapıyor.
     */
    channelHitRate: real('channel_hit_rate'),
    channelAgeDays: real('channel_age_days'),
    channelIsHot: integer('channel_is_hot', { mode: 'boolean' }).notNull().default(false),
    suspectedBoughtTraffic: integer('suspected_bought_traffic', { mode: 'boolean' })
      .notNull()
      .default(false),

    channelName: text('channel_name'),
    subsApprox: integer('subs_approx'),
    subsText: text('subs_text'),
    subsHidden: integer('subs_hidden', { mode: 'boolean' }).notNull().default(false),

    depth: integer('depth').notNull(),
    seedVideoId: text('seed_video_id'),
    status: text('status').notNull().default('pooled'),
    statusChangedAt: integer('status_changed_at').notNull(),
    caughtAt: integer('caught_at').notNull(),

    /** Yalnızca export zenginleştirmesinde dolar. */
    description: text('description'),
    publishedAt: text('published_at'),
    likes: integer('likes'),
    refreshedAt: integer('refreshed_at'),
  },
  (t) => [
    index('idx_videos_status_hype').on(t.status, t.hype),
    index('idx_videos_status_caught').on(t.status, t.caughtAt),
    index('idx_videos_channel').on(t.channelId),
    index('idx_videos_run').on(t.runId),
    // Depolama sınırındaki bütünlük bekçisi: sessiz LOGIN_REQUIRED yanıtları
    // izlenmesi tanımsız kayıtlar üretiyor; böyle bir satır ASLA yazılamaz.
    check('videos_views_sane', sql`${t.views} >= 0`),
    check('videos_score_present', sql`${t.hype} IS NOT NULL OR ${t.vsr} IS NOT NULL`),
  ],
);

/**
 * Huni günlüğü. Her taranan videonun hangi kapıda neden elendiğini tutar —
 * "bu 12 bin aboneli kanalın 400 bin izlenmeli videosu neden gelmedi?"
 * sorusunun cevabı burada.
 *
 * Bilinçli olarak KALICI DEĞİL: 30 gün sonra budanır. Elenmiş bir video,
 * kullanıcı eşiği düşürdüğünde yeniden değerlendirilebilmelidir.
 */
export const observations = sqliteTable(
  'video_observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    videoId: text('video_id').notNull(),
    channelId: text('channel_id'),
    depth: integer('depth').notNull().default(0),
    stage: text('stage').notNull(),
    verdict: text('verdict').notNull(),
    detailsJson: text('details_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uq_observation').on(t.runId, t.videoId),
    index('idx_obs_video').on(t.videoId, t.createdAt),
    index('idx_obs_created').on(t.createdAt),
  ],
);

/** Gönderilen TAM yük saklanır: denetlenebilir ve yeniden oynatılabilir. */
export const videoExports = sqliteTable(
  'exports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    videoId: text('video_id').notNull(),
    exportedAt: integer('exported_at').notNull(),
    destination: text('destination').notNull(),
    destinationDetail: text('destination_detail'),
    payloadVersion: text('payload_version').notNull(),
    payloadJson: text('payload_json').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
    error: text('error'),
  },
  (t) => [index('idx_exports_video').on(t.videoId, t.exportedAt)],
);

/**
 * Radar terminalinin satırları.
 *
 * Gözlem tablosu her videonun kaderini zaten tutuyor; burada ek olarak
 * VİDEO OLMAYAN olaylar var: tohum alındı, mola verildi, ayrıştırıcı uyarısı,
 * derinlik değişti. Bir taramanın neden yavaşladığını ya da neden boş döndüğünü
 * sonradan anlamak için asıl gereken bunlar.
 */
export const runLogs = sqliteTable(
  'run_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    ts: integer('ts').notNull(),
    level: text('level').notNull(),
    msg: text('msg').notNull(),
    videoId: text('video_id'),
    channelId: text('channel_id'),
  },
  (t) => [index('idx_logs_run').on(t.runId, t.id), index('idx_logs_level').on(t.runId, t.level)],
);

export const schema = {
  appState,
  presets,
  runs,
  channels,
  videos,
  observations,
  videoExports,
  runLogs,
};
