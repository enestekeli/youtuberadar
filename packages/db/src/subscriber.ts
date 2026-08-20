import type { EngineSnapshot } from '@hype/core';
import type { EventEnvelope, StopReason } from '@hype/shared';
import type { Storage } from './index.js';
import type { RunStatus } from './repos/runs.js';

export interface PersistenceOptions {
  /** İstatistikler her olayda değil, bu kadar tikte bir yazılır. */
  statsFlushEvery?: number;
}

const STOP_REASON_TO_STATUS: Record<StopReason, RunStatus> = {
  manual: 'aborted',
  max_videos: 'completed',
  budget_exhausted: 'completed',
  completed: 'completed',
  fatal_error: 'failed',
};

/**
 * Motor olaylarını veritabanına yazan abone.
 *
 * Dayanıklı alt küme bilinçli olarak dar: yakalanan videolar ve oturum
 * durumu her zaman yazılır, eleme kararları huni günlüğüne tamponlanarak
 * gider, istatistikler ise tiklerde bir yazılır. Sayaçları her olayda diske
 * yazmak, taramanın kendisinden daha çok iş yapmak olurdu.
 */
export function createPersistenceSubscriber(
  storage: Storage,
  options: PersistenceOptions = {},
): (envelope: EventEnvelope) => void {
  const statsFlushEvery = options.statsFlushEvery ?? 25;
  let ticksSinceFlush = 0;
  let currentDepth = 0;

  return (envelope: EventEnvelope): void => {
    const { event, runId } = envelope;

    switch (event.type) {
      case 'run_started':
        storage.runs.create(event.runId, event.config, null);
        break;

      case 'depth_changed':
        currentDepth = event.depth;
        break;

      case 'video_matched': {
        storage.videos.saveMatch(event.match);
        if (runId !== null) {
          storage.observations.record({
            runId,
            videoId: event.match.videoId,
            channelId: event.match.channelId,
            depth: event.match.depth,
            stage: 'caught',
            verdict: 'caught',
            details: { hype: event.match.hype, vsr: event.match.vsr },
          });
        }
        break;
      }

      case 'video_skipped':
        if (runId !== null) {
          storage.observations.record({
            runId,
            videoId: event.videoId,
            channelId: event.metrics?.channelId ?? null,
            depth: currentDepth,
            stage: event.stage,
            verdict: event.reason,
            // Metrikler saklanıyor ki eşik/aralık sonradan değiştiğinde
            // geçmişe dönük "bunlar gelirdi" sorgusu yapılabilsin.
            ...(event.metrics === undefined
              ? {}
              : {
                  details: {
                    title: event.title ?? null,
                    views: event.metrics.views,
                    ageDays: event.metrics.ageDays,
                    vpd: event.metrics.vpd,
                  },
                }),
          });
        }
        break;

      case 'stats_tick':
        ticksSinceFlush += 1;
        if (ticksSinceFlush >= statsFlushEvery && runId !== null) {
          ticksSinceFlush = 0;
          storage.runs.updateStats(runId, event.stats);
        }
        break;

      case 'state_changed':
        if (runId === null) break;
        if (event.to === 'paused') storage.runs.setStatus(runId, 'paused');
        else if (event.to === 'cooldown') storage.runs.setStatus(runId, 'cooldown');
        else if (event.to === 'crawling' || event.to === 'seeding') {
          storage.runs.setStatus(runId, 'running');
        }
        break;

      case 'run_finished':
        // Kalan gözlemler kaybolmasın: oturum bitişi son tampon boşaltma noktası.
        storage.observations.flush();
        storage.runs.finish(
          event.runId,
          STOP_REASON_TO_STATUS[event.reason],
          event.reason,
          event.stats,
        );
        break;

      default:
        break;
    }
  };
}

/** Motorun düzenli anlık görüntülerini kalıcı hâle getirir (çökme sonrası devam). */
export function createSnapshotPersister(storage: Storage): (snapshot: EngineSnapshot) => void {
  return (snapshot) => storage.runs.saveSnapshot(snapshot);
}
