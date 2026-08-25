import { FakeClock, makeCard } from '@hype/core/testing';
import {
  DEFAULT_CRAWL_CONFIG,
  type DomainEvent,
  type EventEnvelope,
  type Match,
  type ServerEvent,
} from '@hype/shared';
import { describe, expect, it, vi } from 'vitest';
import { Broadcaster, type Socket } from './broadcaster.js';
import { DashboardStream, STATS_THROTTLE_MS } from './stream.js';

class CaptureSocket implements Socket {
  readonly sent: ServerEvent[] = [];
  readyState = 1;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerEvent);
  }
}

function build() {
  const clock = new FakeClock();
  const broadcaster = new Broadcaster('epoch-1', () => clock.now());
  const socket = new CaptureSocket();
  broadcaster.add(socket);
  const stream = new DashboardStream(broadcaster, clock);

  let seq = 0;
  const emit = (event: DomainEvent, runId: string | null = 'run1'): void => {
    const envelope: EventEnvelope = { seq: ++seq, ts: clock.now(), runId, event };
    stream.handle(envelope);
  };

  return { clock, socket, stream, emit };
}

const match = (overrides: Partial<Match> = {}): Match => ({
  videoId: 'vid_hit',
  runId: 'run1',
  channelId: 'UC_small',
  title: 'Yakalanan',
  thumbnailUrl: null,
  durationSec: 600,
  views: 20_000,
  vpd: 6666,
  projectedViews: 69_180,
  publishedAgeDays: 3,
  scoreType: 'hype',
  hype: 12.4,
  vsr: null,
  z: 3.2,
  baselineMedian: 1600,
  baselineN: 9,
  lowConfidence: false,
  lowConfidenceReasons: [],
  channelHitRate: null,
  channelAgeDays: null,
  channelIsHot: true,
  suspectedBoughtTraffic: false,
  channelName: 'Küçük Kanal',
  subsApprox: 12_000,
  subsText: '12.3K subscribers',
  subsHidden: false,
  depth: 1,
  seedVideoId: 'seed1',
  seedQuery: 'elektrikli araç',
  topicScore: 1,
  topicMatches: ['elektrikli araç'],
  caughtAt: 1_754_500_000_000,
  ...overrides,
});

const statsPayload = {
  scanned: 10,
  enqueued: 4,
  expanded: 2,
  matched: 1,
  depth: 1,
  maxDepth: 4,
  frontierSize: 3,
  rejects: {},
  channelCacheHits: 0,
  channelFetches: 1,
  channelNegativeHits: 0,
  requestsTotal: 3,
  requestsClassA: 2,
  requestsClassB: 1,
  http429: 0,
  emptyFeeds: 0,
  loginRequired: 0,
  parserWarnings: 0,
  channelBudgetCap: 300,
  requestBudgetCap: 1500,
  startedAt: 1_754_500_000_000,
  elapsedMs: 1000,
};

describe('kademeli kart doldurma', () => {
  it('ücretsiz kapıları geçen video hemen "skorlanıyor" kartı olarak düşer', () => {
    const { socket, emit } = build();
    emit({ type: 'run_started', runId: 'run1', config: DEFAULT_CRAWL_CONFIG });
    emit({
      type: 'video_scanned',
      card: makeCard({ videoId: 'vid_hit', viewsApprox: 20_000, publishedAgeDays: 3 }),
      depth: 1,
    });

    const added = socket.sent.find((e) => e.type === 'pool:add');
    expect(added?.type).toBe('pool:add');
    if (added?.type !== 'pool:add') return;
    expect(added.item.score).toEqual({ type: 'pending' });
    // Bedava bilgiler zaten kartta: kullanıcı kanal isteğini beklerken bakabilir.
    expect(added.item.views).toBe(20_000);
    expect(added.item.vpd).toBeCloseTo(20_000 / 3, 2);
  });

  it('kanal çözülünce rozet canlanır', () => {
    const { socket, emit } = build();
    emit({ type: 'run_started', runId: 'run1', config: DEFAULT_CRAWL_CONFIG });
    emit({ type: 'video_scanned', card: makeCard({ videoId: 'vid_hit' }), depth: 1 });
    emit({ type: 'video_matched', match: match() });

    const updated = socket.sent.find((e) => e.type === 'pool:update');
    expect(updated?.type).toBe('pool:update');
    if (updated?.type !== 'pool:update') return;
    expect(updated.videoId).toBe('vid_hit');
    expect(updated.patch.score).toEqual({
      type: 'hype',
      value: 12.4,
      z: 3.2,
      lowConfidence: false,
      lowConfidenceReasons: [],
    });
    expect(updated.patch.channelIsHot).toBe(true);
  });

  it('kanal modu yakalaması kanal skoruna çevrilir', () => {
    const { socket, emit } = build();
    emit({ type: 'run_started', runId: 'run1', config: DEFAULT_CRAWL_CONFIG });
    emit({ type: 'video_scanned', card: makeCard({ videoId: 'vid_hit' }), depth: 1 });
    emit({
      type: 'video_matched',
      match: match({
        scoreType: 'channel',
        hype: null,
        vsr: 4.2,
        z: null,
        baselineMedian: 52_000,
        baselineN: 12,
        channelHitRate: 0.75,
        channelAgeDays: 147,
      }),
    });

    const updated = socket.sent.find((e) => e.type === 'pool:update');
    if (updated?.type !== 'pool:update') throw new Error('pool:update beklendi');
    expect(updated.patch.score).toEqual({
      type: 'channel',
      value: 4.2,
      hitRate: 0.75,
      channelAgeDays: 147,
      uploads: 12,
      lowConfidence: false,
      lowConfidenceReasons: [],
    });
  });

  it('elenen aday kartı geri çekilir — kullanıcı boşuna umutlanmaz', () => {
    const { socket, emit } = build();
    emit({ type: 'run_started', runId: 'run1', config: DEFAULT_CRAWL_CONFIG });
    emit({ type: 'video_scanned', card: makeCard({ videoId: 'vid_x' }), depth: 1 });
    emit({
      type: 'video_skipped',
      videoId: 'vid_x',
      stage: 'channel_fetch',
      reason: 'subs_out_of_range',
    });

    const removed = socket.sent.find((e) => e.type === 'pool:remove');
    expect(removed?.type).toBe('pool:remove');
    if (removed?.type !== 'pool:remove') return;
    expect(removed.videoId).toBe('vid_x');
  });

  it('kart hiç gösterilmediyse geri çekme yayınlanmaz', () => {
    const { socket, emit } = build();
    emit({ type: 'run_started', runId: 'run1', config: DEFAULT_CRAWL_CONFIG });
    emit({ type: 'video_skipped', videoId: 'vid_short', stage: 'shape', reason: 'shorts' });
    expect(socket.sent.filter((e) => e.type === 'pool:remove')).toHaveLength(0);
  });
});

describe('akış kontrolü', () => {
  it('istatistikler saniyede birden sık gönderilmez', () => {
    const { socket, clock, emit } = build();
    emit({ type: 'run_started', runId: 'run1', config: DEFAULT_CRAWL_CONFIG });

    emit({ type: 'stats_tick', stats: statsPayload });
    emit({ type: 'stats_tick', stats: statsPayload });
    expect(socket.sent.filter((e) => e.type === 'stats')).toHaveLength(1);

    clock.advance(STATS_THROTTLE_MS + 1);
    emit({ type: 'stats_tick', stats: statsPayload });
    expect(socket.sent.filter((e) => e.type === 'stats')).toHaveLength(2);
  });

  it('log satırları toplu gönderilir', () => {
    vi.useFakeTimers();
    try {
      const { socket, emit, stream } = build();
      for (let i = 0; i < 5; i++) {
        emit({ type: 'depth_changed', depth: i, maxDepth: 4 });
      }
      // Eşik dolmadan gönderilmez; zamanlayıcı ya da flush tetikler.
      expect(socket.sent.filter((e) => e.type === 'log')).toHaveLength(0);

      stream.flush();
      const batch = socket.sent.find((e) => e.type === 'log');
      expect(batch?.type).toBe('log');
      if (batch?.type !== 'log') return;
      expect(batch.lines).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('log satırları seviye ve sebep kodunu taşır', () => {
    const { socket, emit, stream } = build();
    emit({
      type: 'video_skipped',
      videoId: 'vid_x',
      title: 'Bir video',
      stage: 'prefilter',
      reason: 'views_too_low',
    });
    emit({ type: 'video_matched', match: match() });
    stream.flush();

    const batch = socket.sent.find((e) => e.type === 'log');
    if (batch?.type !== 'log') throw new Error('log beklendi');
    const [skip, hit] = batch.lines;
    expect(skip?.level).toBe('skip');
    expect(skip?.msg).toContain('views_too_low');
    expect(hit?.level).toBe('match');
    expect(hit?.msg).toContain('12.4x');
  });

  it('kanal yakalaması logda KAPIYI söyler, sadece çarpanı değil', () => {
    // Tek başına "4.2x" yanıltıcı olurdu: kanalı havuza sokan karar yaş ve
    // medyan izlenme; satır tam olarak o iki sayıyı taşımalı.
    const { socket, emit, stream } = build();
    emit({
      type: 'video_matched',
      match: match({
        scoreType: 'channel',
        hype: null,
        vsr: 4.2,
        baselineN: 12,
        baselineMedian: 45_000,
        channelHitRate: 0.75,
        channelAgeDays: 147,
      }),
    });
    stream.flush();

    const batch = socket.sent.find((e) => e.type === 'log');
    if (batch?.type !== 'log') throw new Error('log beklendi');
    const msg = batch.lines[0]?.msg ?? '';
    // Satır kanalı havuza sokan iki sayıyı taşır: yaş ve MEDYAN izlenme.
    expect(msg).toContain('147 günlük');
    expect(msg).toContain('medyan 45B');
    expect(msg).toContain('12 video');
    expect(msg).toContain('4.2x');
  });

  it('mola durumu geri sayım için bitiş zamanını taşır', () => {
    const { socket, emit } = build();
    emit({ type: 'cooldown_started', until: 1_754_502_700_000, cause: 'login_required', level: 1 });

    const status = socket.sent.find((e) => e.type === 'run:status');
    expect(status?.type).toBe('run:status');
    if (status?.type !== 'run:status') return;
    expect(status.state).toBe('cooldown');
    expect(status.cooldownUntil).toBe(1_754_502_700_000);
  });

  it('son log kuyruğu geç bağlanan istemci için saklanır', () => {
    const { emit, stream } = build();
    emit({ type: 'depth_changed', depth: 1, maxDepth: 4 });
    expect(stream.logTail).toHaveLength(1);
  });
});

describe('tarama sınırları', () => {
  it('yeni tarama başlayınca log kuyruğu sıfırlanır', () => {
    const { emit, stream } = build();
    emit({ type: 'depth_changed', depth: 1, maxDepth: 4 });
    emit({ type: 'depth_changed', depth: 2, maxDepth: 4 });
    expect(stream.logTail.length).toBe(2);

    // Sayfa yenilenince gönderilen kuyruk, önceki taramanın satırlarını
    // taşırsa "0 video tarandı" başlığıyla çelişir.
    emit({ type: 'run_started', runId: 'run2', config: DEFAULT_CRAWL_CONFIG });
    expect(stream.logTail.length).toBe(1);
    expect(stream.logTail[0]?.msg).toContain('run2');
  });
});
