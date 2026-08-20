import { suspectsBoughtTraffic } from '@hype/core';
import type { Storage } from '@hype/db';
import { EXPORT_SCHEMA_VERSION, type ExportEnvelope } from '@hype/shared';
import { APP_VERSION } from './composition.js';

export interface ExportContext {
  storage: Storage;
  /** Export anında tek bir pahalı istekle açıklama/tarih/beğeni tazeler. */
  enrich?: (videoId: string) => Promise<{
    description: string | null;
    publishedAt: string | null;
    views: number | null;
    likes: number | null;
  }>;
}

const BASE_CAVEATS = [
  'Abone sayısı YouTube tarafından ~3 anlamlı basamağa yuvarlanmıştır',
  'İzlenme ve hız değerleri yakalama anındaki anlık görüntüdür',
];

/**
 * "Analize Gönder" zarfını üretir.
 *
 * İki tasarım kararı burada: zarf VERSİYONLU (tüketici ajanlar sözleşmeye
 * güvenebilsin) ve `caveats` alanı veri kalitesi sınırlarını AÇIKÇA taşıyor.
 * Yuvarlanmış bir abone sayısını kesinmiş gibi devretmek, aşağı akıştaki
 * modelin yanlış sonuç üretmesine sebep olur.
 *
 * Zenginleştirme başarısız olursa export yine çıkar — yalnızca null alanlar ve
 * bir uyarı ile. Export asla YouTube'a bloklanmaz.
 */
export async function buildExportEnvelope(
  ctx: ExportContext,
  videoId: string,
  exportedAt: number,
): Promise<ExportEnvelope | null> {
  const row = ctx.storage.videos.getRow(videoId);
  if (row === null) return null;

  const caveats = [...BASE_CAVEATS];
  let description = row.description;
  let publishedAt = row.publishedAt;
  let views = row.views;
  let likes = row.likes;

  if (ctx.enrich !== undefined) {
    try {
      const details = await ctx.enrich(videoId);
      description = details.description ?? description;
      publishedAt = details.publishedAt ?? publishedAt;
      views = details.views ?? views;
      likes = details.likes ?? likes;
      ctx.storage.videos.enrich(videoId, {
        description,
        publishedAt,
        likes,
        suspectedBoughtTraffic: suspectsBoughtTraffic(likes, views),
      });
    } catch {
      caveats.push('Export anında zenginleştirme başarısız oldu; açıklama ve kesin tarih eksik');
    }
  }

  if (row.subsHidden) caveats.push('Kanal abone sayısını gizlemiş');
  if (row.lowConfidence) {
    caveats.push('Skor düşük güvenli: taban çizgisi ince ya da video çok genç');
  }

  return {
    schema: EXPORT_SCHEMA_VERSION,
    exported_at: new Date(exportedAt).toISOString(),
    video: {
      id: row.videoId,
      url: `https://www.youtube.com/watch?v=${row.videoId}`,
      title: row.title,
      description,
      duration_s: row.durationSec,
      published_at: publishedAt,
      age_days: row.publishedAgeDays,
      view_count: views,
      views_per_day: row.vpd,
      thumbnail_url: row.thumbnailUrl,
    },
    channel: {
      id: row.channelId,
      url: `https://www.youtube.com/channel/${row.channelId}`,
      title: row.channelName,
      handle: null,
      subscriber_count: row.subsApprox,
      subscriber_count_is_approx: true,
      subs_hidden: row.subsHidden,
      is_hot: row.channelIsHot,
      baseline:
        row.baselineMedian === null || row.baselineN === null
          ? null
          : {
              stat: 'median',
              median_projected_views: row.baselineMedian,
              sample_n: row.baselineN,
              lookback_days: 365,
            },
    },
    scores: {
      type: row.scoreType === 'vsr' ? 'vsr' : 'hype',
      hype: row.hype,
      vsr: row.vsr,
      z: row.z,
      projected_views: row.projectedViews,
      low_confidence: row.lowConfidence,
      suspected_bought_traffic: row.suspectedBoughtTraffic,
      thresholds: { hype: 5, vsr: 3 },
    },
    provenance: {
      run_id: row.runId,
      depth: row.depth,
      seed_video_id: row.seedVideoId,
      caught_at: new Date(row.caughtAt).toISOString(),
      app_version: APP_VERSION,
      data_source: 'innertube-unofficial',
      caveats,
    },
  };
}
