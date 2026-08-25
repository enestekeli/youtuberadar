import { describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_CONFIG } from './config.js';
import { DomainEventSchema, EventEnvelopeSchema, FunnelStatsSchema } from './events.js';
import { ClientFrameSchema, hypeTier, PoolItemSchema, ServerEventSchema } from './protocol.js';

const sampleStats = FunnelStatsSchema.parse({
  scanned: 842,
  enqueued: 120,
  expanded: 40,
  matched: 9,
  depth: 3,
  maxDepth: 4,
  frontierSize: 77,
  rejects: { shorts: 210, views_too_low: 400 },
  channelCacheHits: 17,
  channelFetches: 44,
  channelNegativeHits: 12,
  requestsTotal: 512,
  requestsClassA: 90,
  requestsClassB: 422,
  http429: 0,
  emptyFeeds: 0,
  loginRequired: 0,
  parserWarnings: 1,
  channelBudgetCap: 300,
  requestBudgetCap: 1500,
  startedAt: 1_754_500_000_000,
  elapsedMs: 120_000,
});

describe('DomainEvent / EventEnvelope', () => {
  it('örnek olaylar şemadan geçer', () => {
    const events = [
      { type: 'run_started', runId: 'r1', config: DEFAULT_CRAWL_CONFIG },
      { type: 'state_changed', from: 'idle', to: 'seeding' },
      { type: 'seed_acquired', videoId: 'abc123def45', title: 'Test', manual: false },
      {
        type: 'video_skipped',
        videoId: 'abc123def45',
        stage: 'prefilter',
        reason: 'views_too_low',
      },
      {
        type: 'video_skipped',
        videoId: 'scored-low',
        stage: 'score',
        reason: 'below_threshold',
        metrics: {
          views: 20_000,
          ageDays: 30,
          vpd: 666,
          channelId: 'UC_test',
          score: {
            scoreType: 'hype',
            hype: 1.2,
            vsr: null,
            z: 0.4,
            projectedViews: 20_000,
            baselineMedian: 16_000,
            baselineN: 8,
            baselineSamples: [15_000, 16_000, 17_000],
            lowConfidence: false,
            lowConfidenceReasons: [],
            channelIsHot: false,
          },
        },
      },
      { type: 'stats_tick', stats: sampleStats },
      { type: 'cooldown_started', until: 1_754_500_600_000, cause: 'login_required', level: 1 },
      { type: 'run_finished', runId: 'r1', reason: 'max_videos', stats: sampleStats },
    ];
    for (const e of events) {
      const r = DomainEventSchema.safeParse(e);
      expect(r.success, `olay geçmedi: ${JSON.stringify(e).slice(0, 80)}`).toBe(true);
    }
  });

  it('bilinmeyen olay tipi reddedilir', () => {
    expect(DomainEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('zarf JSON gidiş-dönüşünden sağ çıkar', () => {
    const env = {
      seq: 42,
      ts: 1_754_500_000_000,
      runId: 'r1',
      event: { type: 'depth_changed', depth: 2, maxDepth: 4 },
    };
    const parsed = EventEnvelopeSchema.parse(JSON.parse(JSON.stringify(env)));
    expect(parsed).toEqual(env);
  });
});

describe('WS protokolü', () => {
  it('pool:add + pending skor geçerli', () => {
    const r = ServerEventSchema.safeParse({
      seq: 1,
      ts: 1_754_500_000_000,
      type: 'pool:add',
      runId: 'r1',
      item: {
        videoId: 'abc123def45',
        runId: 'r1',
        title: 'Video',
        thumbnailUrl: null,
        durationSec: 300,
        channelId: null,
        channelName: null,
        subsText: null,
        subsApprox: null,
        views: 84_213,
        ageDays: 4.2,
        vpd: 20_050,
        score: { type: 'pending' },
        receipts: null,
        channelIsHot: false,
        suspectedBoughtTraffic: false,
        discarded: false,
        depth: 3,
        caughtAt: null,
      },
    });
    expect(r.success).toBe(true);
  });

  it('kanal skoru gidiş-dönüş yapar ve eksik alan reddedilir', () => {
    const score = {
      type: 'channel' as const,
      value: 4.2,
      hitRate: 0.83,
      channelAgeDays: 147,
      uploads: 12,
      lowConfidence: false,
      lowConfidenceReasons: [],
    };
    const ok = PoolItemSchema.partial().safeParse({ score });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.score).toEqual(score);

    // Kuruluş tarihi okunamamış kanal: yaş null OLABİLİR ama alan zorunlu.
    expect(
      PoolItemSchema.partial().safeParse({ score: { ...score, channelAgeDays: null } }).success,
    ).toBe(true);
    const { hitRate: _atilan, ...eksik } = score;
    expect(PoolItemSchema.partial().safeParse({ score: eksik }).success).toBe(false);
  });

  it('resume çerçevesi geçerli, bilinmeyen çerçeve değil', () => {
    expect(
      ClientFrameSchema.safeParse({ type: 'resume', epochId: null, fromSeq: null }).success,
    ).toBe(true);
    expect(ClientFrameSchema.safeParse({ type: 'subscribe' }).success).toBe(false);
  });

  it('PoolItem partial patch parse edilir (pool:update yolu)', () => {
    const patch = PoolItemSchema.partial().safeParse({
      score: { type: 'hype', value: 12.4, z: 4.1, lowConfidence: false },
      caughtAt: 1_754_500_100_000,
    });
    expect(patch.success).toBe(true);
  });
});

describe('hypeTier', () => {
  it('sektör kesme noktalarını uygular', () => {
    expect(hypeTier(15)).toBe('mega');
    expect(hypeTier(10)).toBe('mega');
    expect(hypeTier(7)).toBe('hot');
    expect(hypeTier(5)).toBe('hot');
    expect(hypeTier(3)).toBe('warm');
    expect(hypeTier(1.5)).toBe('neutral');
  });
});
