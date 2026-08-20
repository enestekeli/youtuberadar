import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrawlerEngine, seededRng, TypedEventBus } from '@hype/core';
import {
  FakeClock,
  type FakeScenario,
  FakeYouTubeGateway,
  makeCard,
  makeSnapshot,
  makeUploads,
} from '@hype/core/testing';
import { type CrawlConfig, DEFAULT_CRAWL_CONFIG, VideosQuerySchema } from '@hype/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type Storage } from './index.js';
import { createPersistenceSubscriber, createSnapshotPersister } from './subscriber.js';

const SMALL = 'UC_small';
const BIG = 'UC_big';
const OLD = { startAgeDays: 35, ageStepDays: 7 };

const scenario = (): FakeScenario => ({
  homeFeed: [],
  searchFeed: {
    '*': Array.from({ length: 5 }, (_, i) =>
      makeCard({
        videoId: i === 0 ? 'seed1' : `seed${i + 1}`,
        channelId: BIG,
        viewsApprox: 500_000,
        publishedAgeDays: 5,
      }),
    ),
  },
  edges: {
    seed1: [
      makeCard({ videoId: 'vid_hit', channelId: SMALL, viewsApprox: 20_000, publishedAgeDays: 3 }),
      makeCard({ videoId: 'vid_ord', channelId: SMALL, viewsApprox: 3000, publishedAgeDays: 8 }),
      makeCard({ videoId: 'vid_short', channelId: SMALL, kind: 'short', durationSec: 45 }),
    ],
  },
  channels: {
    [SMALL]: makeSnapshot({
      channelId: SMALL,
      subsApprox: 12_000,
      recentUploads: makeUploads(
        [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
        OLD,
      ),
    }),
    [BIG]: makeSnapshot({ channelId: BIG, subsApprox: 5_000_000, recentUploads: [] }),
  },
  filler: { count: 4, channelId: SMALL, views: 3000, ageDays: 10 },
});

const config: CrawlConfig = { ...DEFAULT_CRAWL_CONFIG, maxVideosScanned: 50, maxDepth: 3 };

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hype-int-'));
  dbPath = join(dir, 'hype.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(): Storage {
  return createStorage({ path: dbPath, appVersion: '0.1.0' });
}

async function crawl(storage: Storage, runId: string) {
  const clock = new FakeClock();
  const bus = new TypedEventBus(clock);
  const gateway = new FakeYouTubeGateway(scenario());
  bus.subscribe(createPersistenceSubscriber(storage, { statsFlushEvery: 1 }));

  const engine = new CrawlerEngine({
    gateway,
    channels: storage.channels,
    seen: storage.seen,
    clock,
    sleeper: clock,
    rng: seededRng(1234),
    bus,
    persistSnapshot: createSnapshotPersister(storage),
    snapshotEveryNExpansions: 2,
  });

  const reason = await engine.start(runId, config);
  storage.observations.flush();
  return { reason, gateway };
}

describe('motor + SQLite uçtan uca', () => {
  it('yakalanan video kalıcı olarak yazılır ve huni günlüğü dolar', async () => {
    const storage = open();
    const { reason, gateway } = await crawl(storage, 'run1');
    expect(reason).toBe('max_videos');

    const pooled = storage.videos.list(VideosQuerySchema.parse({})).items;
    expect(pooled.map((v) => v.videoId)).toContain('vid_hit');

    const hit = storage.videos.get('vid_hit');
    expect(hit?.score.type).toBe('hype');
    expect(hit?.receipts?.baselineN).toBe(8);

    const breakdown = storage.observations.verdictBreakdown('run1');
    expect(breakdown.caught ?? 0).toBeGreaterThanOrEqual(1);
    expect(breakdown.shorts ?? 0).toBeGreaterThanOrEqual(1);
    expect(breakdown.views_too_low ?? 0).toBeGreaterThan(0);

    const run = storage.runs.get('run1');
    expect(run?.status).toBe('stopped');
    expect(run?.stopReason).toBe('max_videos');
    expect(run?.stats?.matched ?? 0).toBeGreaterThanOrEqual(1);
    // Anlık görüntü yazıldı: süreç burada çökse kaldığı yerden devam edebilirdi.
    expect(storage.runs.loadSnapshot('run1')?.budgets.videosScanned).toBeGreaterThan(0);

    storage.close();
  });

  it('süreç yeniden başlasa bile aynı video ikinci kez havuza girmez', async () => {
    const first = open();
    await crawl(first, 'run1');
    expect(first.videos.get('vid_hit')).not.toBeNull();
    first.close();

    // Yepyeni bir süreç: bellekteki hiçbir şey taşınmıyor, yalnızca disk.
    const second = open();
    await crawl(second, 'run2');

    const fromRun2 = second.videos
      .list(VideosQuerySchema.parse({ runId: 'run2', status: 'all' }))
      .items.map((v) => v.videoId);
    expect(fromRun2).not.toContain('vid_hit');

    // Video hâlâ havuzda ama ilk taramaya ait — çift kayıt yok.
    expect(second.videos.getRow('vid_hit')?.runId).toBe('run1');
    expect(second.observations.verdictBreakdown('run2').seen ?? 0).toBeGreaterThanOrEqual(1);
    second.close();
  });

  it('kanal önbelleği yeniden başlatmadan sağ çıkar ve ikinci tarama istek harcamaz', async () => {
    const first = open();
    const run1 = await crawl(first, 'run1');
    expect(run1.gateway.channelCalls).toBe(1);
    first.close();

    const second = open();
    const run2 = await crawl(second, 'run2');
    // Diskteki önbellek sayesinde ikinci tarama tek bir kanal isteği bile atmadı.
    expect(run2.gateway.channelCalls).toBe(0);
    second.close();
  });

  it('kullanıcının çöpe attığı video sonraki taramada geri gelmez', async () => {
    const first = open();
    await crawl(first, 'run1');
    first.videos.setStatus('vid_hit', 'discarded');
    first.close();

    const second = open();
    await crawl(second, 'run2');

    const visible = second.videos.list(VideosQuerySchema.parse({})).items.map((v) => v.videoId);
    expect(visible).not.toContain('vid_hit');
    expect(second.videos.getRow('vid_hit')?.status).toBe('discarded');
    second.close();
  });
});
