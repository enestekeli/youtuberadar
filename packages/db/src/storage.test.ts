import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CRAWL_CONFIG, type Match, VideosQuerySchema } from '@hype/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type Storage } from './index.js';
import { pruneArchive, runMaintenance, shouldRunMaintenance } from './maintenance.js';

let dir: string;
let storage: Storage;
let clock = 1_754_500_000_000;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    videoId: 'vid_hit',
    runId: 'run1',
    channelId: 'UC_small',
    title: 'Yakalanan video',
    thumbnailUrl: 'https://i.ytimg.com/vi/x/hq.jpg',
    durationSec: 600,
    views: 20_000,
    vpd: 6666,
    projectedViews: 69_180,
    publishedAgeDays: 3,
    scoreType: 'hype',
    hype: 6.9,
    vsr: null,
    z: 3.2,
    baselineMedian: 10_000,
    baselineN: 8,
    lowConfidence: false,
    lowConfidenceReasons: [],
    channelHitRate: null,
    channelAgeDays: null,
    channelIsHot: false,
    suspectedBoughtTraffic: false,
    channelName: 'Küçük Kanal',
    subsApprox: 12_000,
    subsText: '12.3K subscribers',
    subsHidden: false,
    depth: 1,
    seedVideoId: 'seed1',
    caughtAt: clock,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hype-db-'));
  clock = 1_754_500_000_000;
  storage = createStorage({ path: join(dir, 'test.db'), appVersion: '0.1.0', now: () => clock });
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('kurulum', () => {
  it('migration çalışır ve yerleşik presetler kurulur', () => {
    const presets = storage.presets.list();
    expect(presets.length).toBeGreaterThanOrEqual(3);
    expect(presets.every((p) => p.builtin)).toBe(true);
    expect(presets.map((p) => p.name)).toContain('Dengeli (1B–50B abone)');
    // Her yerleşik ayarın ne işe yaradığı yazılı olmalı; kullanıcı sormak
    // zorunda kalmasın.
    expect(presets.every((p) => (p.description ?? '').length > 20)).toBe(true);
  });

  it('yeniden adlandırılan yerleşik ayarlar listede birikmez', () => {
    // Eski sürümden kalma bir yerleşik kayıt taklit et.
    storage.presets.create({ name: 'Default 1k–50k', config: DEFAULT_CRAWL_CONFIG });
    storage.handle.raw
      .prepare("update presets set builtin = 1 where name = 'Default 1k–50k'")
      .run();

    storage.presets.seedBuiltins();
    const names = storage.presets.list().map((p) => p.name);
    expect(names).not.toContain('Default 1k–50k');
    expect(names).toContain('Dengeli (1B–50B abone)');
  });

  it('yerleşik presetler ikinci açılışta çoğalmaz', () => {
    const before = storage.presets.list().length;
    storage.presets.seedBuiltins();
    expect(storage.presets.list()).toHaveLength(before);
  });

  it('yerleşik preset silinemez', () => {
    const builtin = storage.presets.list()[0];
    expect(builtin).toBeDefined();
    if (builtin === undefined) return;
    expect(storage.presets.delete(builtin.id)).toBe(false);
  });
});

describe('anahtar-değer deposu', () => {
  it('yazılan değer okunur ve üzerine yazılabilir', async () => {
    expect(await storage.kv.get('visitor_data')).toBeNull();
    await storage.kv.set('visitor_data', 'abc');
    expect(await storage.kv.get('visitor_data')).toBe('abc');
    await storage.kv.set('visitor_data', 'def');
    expect(await storage.kv.get('visitor_data')).toBe('def');
  });
});

describe('kanal önbelleği', () => {
  const snapshot = {
    channelId: 'UC_small',
    name: 'Küçük Kanal',
    handle: '@kucuk',
    subsApprox: 12_000,
    subsText: '12.3K subscribers',
    subsHidden: false,
    country: null,
    recentUploads: [],
    fetchedAt: clock,
  };

  it('anlık görüntü gidiş-dönüşünden sağ çıkar', async () => {
    await storage.channels.putSnapshot(snapshot, 'in_range', null, clock);
    const cached = await storage.channels.get('UC_small');
    expect(cached?.snapshot?.subsApprox).toBe(12_000);
    expect(cached?.verdict).toBe('in_range');
  });

  it('negatif verdikt anlık görüntü olmadan yazılabilir', async () => {
    await storage.channels.putVerdict('UC_dev', 'out_of_range', clock + 1000);
    const cached = await storage.channels.get('UC_dev');
    expect(cached?.verdict).toBe('out_of_range');
    expect(cached?.snapshot).toBeNull();
    expect(cached?.verdictExpiresAt).toBe(clock + 1000);
  });

  it('verdikt güncellemesi mevcut anlık görüntüyü silmez', async () => {
    await storage.channels.putSnapshot(snapshot, 'in_range', null, clock);
    await storage.channels.putVerdict('UC_small', 'blocklisted', null);
    const cached = await storage.channels.get('UC_small');
    expect(cached?.verdict).toBe('blocklisted');
    expect(cached?.snapshot).not.toBeNull();
  });

  it('kuruluş tarihi ve ülke kalıcı saklanır', async () => {
    await storage.channels.putAbout('UC_yeni', 'Germany', 1_740_000_000_000);
    const cached = await storage.channels.get('UC_yeni');
    expect(cached?.country).toBe('Germany');
    expect(cached?.joinedAt).toBe(1_740_000_000_000);
  });

  it('null gelen alan ÖĞRENİLMİŞ değeri ezmez', async () => {
    /*
     * YouTube'un şeması değiştiğinde ya da tek bir yanıt eksik geldiğinde daha
     * önce öğrendiğimizi kaybetmek, hiç öğrenmemekten kötü: kanal yaşı bir daha
     * asla sorulmayacak bir bilgi.
     */
    await storage.channels.putAbout('UC_yeni', 'Germany', 1_740_000_000_000);
    await storage.channels.putAbout('UC_yeni', null, null);

    const cached = await storage.channels.get('UC_yeni');
    expect(cached?.country).toBe('Germany');
    expect(cached?.joinedAt).toBe(1_740_000_000_000);
  });

  it('anlık görüntü tazelemesi kuruluş tarihini korur', async () => {
    // Anlık görüntü 6 saatte bayatlıyor; kuruluş tarihi ise hiç değişmez ve
    // her tazelemede yeniden sorulmamalı.
    await storage.channels.putAbout('UC_small', 'Türkiye', 1_700_000_000_000);
    await storage.channels.putSnapshot(snapshot, 'in_range', null, clock);

    const cached = await storage.channels.get('UC_small');
    expect(cached?.joinedAt).toBe(1_700_000_000_000);
  });
});

describe('havuz', () => {
  it('yakalanan video kaydedilir ve okunur', () => {
    storage.videos.saveMatch(makeMatch());
    const item = storage.videos.get('vid_hit');
    expect(item?.score).toEqual({
      type: 'hype',
      value: 6.9,
      z: 3.2,
      lowConfidence: false,
      lowConfidenceReasons: [],
    });
    expect(item?.receipts?.baselineN).toBe(8);
    expect(item?.discarded).toBe(false);
  });

  it('düşük güven sebepleri diske yazılır ve geri okunur', () => {
    // Sebepler kaybolursa arayüz yalnızca "düşük güven" diyebilir; kullanıcı
    // taban ince mi, video mu genç ayırt edemez.
    storage.videos.saveMatch(
      makeMatch({
        videoId: 'vid_zayif',
        lowConfidence: true,
        lowConfidenceReasons: ['thin_baseline', 'newer_uploads_only'],
      }),
    );
    const score = storage.videos.get('vid_zayif')?.score;
    expect(score?.type).toBe('hype');
    if (score?.type !== 'hype') return;
    expect(score.lowConfidenceReasons).toEqual(['thin_baseline', 'newer_uploads_only']);
  });

  it('kanal modu satırı gidiş-dönüş yapar ve CHECK kısıtını geçer', () => {
    /*
     * `videos_score_present` CHECK'i hype ya da vsr'den birinin dolu olmasını
     * istiyor ve SQLite'ta CHECK değiştirmek tabloyu yeniden inşa etmek demek.
     * Kanal çarpanı bu yüzden `vsr` kolonunu paylaşıyor; ayrımı `score_type`
     * yapıyor. Bu test o kararın GERÇEK veritabanında tuttuğunu kanıtlıyor.
     */
    storage.videos.saveMatch(
      makeMatch({
        videoId: 'vid_kanal',
        scoreType: 'channel',
        hype: null,
        vsr: 4.2,
        z: null,
        baselineMedian: 52_000,
        baselineN: 12,
        channelHitRate: 0.83,
        channelAgeDays: 147,
      }),
    );

    const score = storage.videos.get('vid_kanal')?.score;
    expect(score).toEqual({
      type: 'channel',
      value: 4.2,
      hitRate: 0.83,
      channelAgeDays: 147,
      uploads: 12,
      lowConfidence: false,
      lowConfidenceReasons: [],
    });
  });

  it('kuruluş tarihi okunamayan kanal satırı da saklanır', () => {
    storage.videos.saveMatch(
      makeMatch({
        videoId: 'vid_yassiz',
        scoreType: 'channel',
        hype: null,
        vsr: 3.1,
        channelHitRate: 0.6,
        channelAgeDays: null,
        lowConfidence: true,
        lowConfidenceReasons: ['age_unknown'],
      }),
    );
    const score = storage.videos.get('vid_yassiz')?.score;
    expect(score?.type).toBe('channel');
    if (score?.type !== 'channel') return;
    expect(score.channelAgeDays).toBeNull();
    expect(score.lowConfidenceReasons).toEqual(['age_unknown']);
  });

  it('bozuk metrikli kayıt depolama sınırında reddedilir', () => {
    // Sessiz LOGIN_REQUIRED imzası: yapısal olarak dolu, sayısal olarak çöp.
    expect(() => storage.videos.saveMatch(makeMatch({ views: Number.NaN }))).toThrow();
    expect(() => storage.videos.saveMatch(makeMatch({ hype: Number.POSITIVE_INFINITY }))).toThrow();
    expect(storage.videos.get('vid_hit')).toBeNull();
  });

  it('çöpe atma silme değil durum değişikliğidir', () => {
    storage.videos.saveMatch(makeMatch());
    storage.videos.setStatus('vid_hit', 'discarded');

    const item = storage.videos.get('vid_hit');
    expect(item).not.toBeNull();
    expect(item?.discarded).toBe(true);
    // Satır durduğu için sonraki taramalarda "görüldü" sayılır ve geri gelmez.
    expect(storage.videos.getRow('vid_hit')?.status).toBe('discarded');
  });

  it('video yeniden yakalanınca skor tazelenir ama kullanıcının kararı korunur', () => {
    storage.videos.saveMatch(makeMatch());
    storage.videos.setStatus('vid_hit', 'discarded');
    storage.videos.saveMatch(makeMatch({ views: 50_000, hype: 12.4 }));

    const row = storage.videos.getRow('vid_hit');
    expect(row?.views).toBe(50_000);
    expect(row?.hype).toBe(12.4);
    expect(row?.status).toBe('discarded');
  });

  it('zenginleştirme yalnızca ek alanları doldurur', () => {
    storage.videos.saveMatch(makeMatch());
    storage.videos.enrich('vid_hit', { description: 'açıklama', likes: 900 });
    const row = storage.videos.getRow('vid_hit');
    expect(row?.description).toBe('açıklama');
    expect(row?.likes).toBe(900);
    expect(row?.hype).toBe(6.9);
  });
});

describe('havuz sorgusu', () => {
  beforeEach(() => {
    storage.videos.saveMatch(makeMatch({ videoId: 'a', hype: 12, views: 100_000, title: 'Kedi' }));
    storage.videos.saveMatch(
      makeMatch({ videoId: 'b', hype: 4, views: 50_000, title: 'Köpek', channelIsHot: true }),
    );
    storage.videos.saveMatch(
      makeMatch({ videoId: 'c', hype: null, vsr: 8, scoreType: 'vsr', lowConfidence: true }),
    );
    storage.videos.setStatus('a', 'discarded');
  });

  const query = (overrides: Record<string, unknown> = {}) => VideosQuerySchema.parse(overrides);

  it('varsayılan olarak yalnızca havuzdakileri döner', () => {
    const ids = storage.videos.list(query()).items.map((i) => i.videoId);
    expect(ids).not.toContain('a');
    expect(ids).toHaveLength(2);
  });

  it('eşik iki skor türüne de uygulanır', () => {
    const ids = storage.videos.list(query({ minHype: 5 })).items.map((i) => i.videoId);
    // b (hype 4) elenir, c (vsr 8) kalır — iki metrik ayrı kolonda ama tek eşikle.
    expect(ids).toEqual(['c']);
  });

  it('skor türüne göre filtrelenir ve ayrı gösterilir', () => {
    const vsrOnly = storage.videos.list(query({ scoreType: 'vsr' })).items;
    expect(vsrOnly).toHaveLength(1);
    expect(vsrOnly[0]?.score.type).toBe('vsr');
  });

  it('altın yıldız ve düşük güven filtreleri çalışır', () => {
    expect(storage.videos.list(query({ goldStarOnly: true })).items.map((i) => i.videoId)).toEqual([
      'b',
    ]);
    expect(
      storage.videos.list(query({ hideLowConfidence: true })).items.map((i) => i.videoId),
    ).toEqual(['b']);
  });

  it('başlık araması ve sıralama', () => {
    expect(storage.videos.list(query({ q: 'Köpek' })).items).toHaveLength(1);
    const byViews = storage.videos.list(query({ status: 'all', sort: 'views' })).items;
    expect(byViews[0]?.videoId).toBe('a');
  });

  it('sayfalama imleci ilerler', () => {
    const first = storage.videos.list(query({ status: 'all', limit: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = storage.videos.list(
      query({ status: 'all', limit: 1, cursor: first.nextCursor ?? undefined }),
    );
    expect(second.items[0]?.videoId).not.toBe(first.items[0]?.videoId);
  });
});

describe('oturumlar', () => {
  it('oluşturma, istatistik ve bitiş', () => {
    storage.runs.create('run1', DEFAULT_CRAWL_CONFIG, null);
    expect(storage.runs.get('run1')?.status).toBe('crawling');

    storage.runs.finish('run1', 'completed', 'max_videos', null);
    const detail = storage.runs.get('run1');
    expect(detail?.status).toBe('stopped');
    expect(detail?.stopReason).toBe('max_videos');
    expect(detail?.endedAt).not.toBeNull();
  });

  it('çökme sonrası çalışan oturumlar kesintiye uğramış işaretlenir', () => {
    storage.runs.create('run1', DEFAULT_CRAWL_CONFIG, null);
    expect(storage.runs.markInterrupted()).toBe(1);
    expect(storage.runs.findResumable()?.runId).toBe('run1');
  });

  it('anlık görüntü gidiş-dönüşü harcanan bütçeyi korur', () => {
    storage.runs.create('run1', DEFAULT_CRAWL_CONFIG, null);
    storage.runs.saveSnapshot({
      runId: 'run1',
      config: DEFAULT_CRAWL_CONFIG,
      frontier: [{ videoId: 'x', depth: 2, vpd: 100, parentVideoId: null, addedSeq: 1 }],
      budgets: {
        videosScanned: 120,
        channelFetches: 9,
        requestsTotal: 40,
        requestsClassA: 18,
        requestsClassB: 22,
      },
      sessionSeen: ['x'],
      currentSeedId: 'seed1',
      currentDepth: 2,
    });

    const restored = storage.runs.loadSnapshot('run1');
    expect(restored?.budgets.videosScanned).toBe(120);
    expect(restored?.frontier).toHaveLength(1);
  });
});

describe('huni günlüğü', () => {
  it('tamponlanır ve boşaltıldığında yazılır', () => {
    for (let i = 0; i < 5; i++) {
      storage.observations.record({
        runId: 'run1',
        videoId: `v${i}`,
        depth: 1,
        stage: 'prefilter',
        verdict: 'views_too_low',
      });
    }
    expect(storage.observations.verdictBreakdown('run1')).toEqual({});

    storage.observations.flush();
    expect(storage.observations.verdictBreakdown('run1')).toEqual({ views_too_low: 5 });
  });

  it('aynı taramada aynı video iki kez yazılmaz', () => {
    for (let i = 0; i < 2; i++) {
      storage.observations.record({
        runId: 'run1',
        videoId: 'v1',
        depth: 1,
        stage: 'shape',
        verdict: 'shorts',
      });
    }
    storage.observations.flush();
    expect(storage.observations.verdictBreakdown('run1')).toEqual({ shorts: 1 });
  });
});

describe('bakım', () => {
  it('rutin bakım HİÇBİR veriyi silmez', () => {
    // Kullanıcı kararı: veri saklamak bedava, silinen veri geri gelmez.
    // Geçmişe dönük "eşiği düşürseydim ne gelirdi?" sorgusu buna bağlı.
    storage.observations.record({
      runId: 'run1',
      videoId: 'eski',
      depth: 1,
      stage: 'prefilter',
      verdict: 'views_too_low',
    });
    storage.observations.flush();

    const report = runMaintenance(storage.handle.db, clock + 400 * 86_400_000);
    expect(report.observationsDeleted).toBe(0);
    expect(storage.observations.verdictBreakdown('run1')).toEqual({ views_too_low: 1 });
  });

  it('elenen video metrikleriyle saklanır (sonradan filtrelenebilsin)', () => {
    storage.observations.record({
      runId: 'run1',
      videoId: 'elenen',
      channelId: 'UC_x',
      depth: 2,
      stage: 'prefilter',
      verdict: 'views_too_low',
      details: { title: 'Bir video', views: 4200, ageDays: 6, vpd: 700 },
    });
    storage.observations.flush();

    const rows = storage.observations.listForRun('run1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toEqual({ title: 'Bir video', views: 4200, ageDays: 6, vpd: 700 });
    expect(rows[0]?.channelId).toBe('UC_x');
  });

  it('açık istek üzerine budama eski elemeleri siler, yakalananları korur', () => {
    storage.observations.record({
      runId: 'run1',
      videoId: 'eski',
      depth: 1,
      stage: 'prefilter',
      verdict: 'views_too_low',
    });
    storage.observations.record({
      runId: 'run1',
      videoId: 'yakalanan',
      depth: 1,
      stage: 'caught',
      verdict: 'caught',
    });
    storage.observations.flush();

    const report = pruneArchive(storage.handle.db, clock + 40 * 86_400_000, {
      observationRetentionMs: 30 * 86_400_000,
    });
    expect(report.observationsDeleted).toBe(1);
    expect(storage.observations.verdictBreakdown('run1')).toEqual({ caught: 1 });
  });

  it('kara listedeki ve videoya bağlı kanallar korunur', async () => {
    await storage.channels.putVerdict('UC_dev', 'blocklisted', null);
    await storage.channels.putVerdict('UC_eski', 'out_of_range', clock);
    storage.videos.saveMatch(makeMatch({ channelId: 'UC_bagli' }));
    await storage.channels.putVerdict('UC_bagli', 'in_range', null);

    const report = pruneArchive(storage.handle.db, clock + 100 * 86_400_000, {
      channelRetentionMs: 90 * 86_400_000,
    });
    expect(report.channelsDeleted).toBe(1);
    expect(await storage.channels.get('UC_dev')).not.toBeNull();
    expect(await storage.channels.get('UC_bagli')).not.toBeNull();
    expect(await storage.channels.get('UC_eski')).toBeNull();
  });

  it('bakım günde birden fazla koşmaz', () => {
    expect(shouldRunMaintenance(null, clock)).toBe(true);
    expect(shouldRunMaintenance(String(clock), clock + 1000)).toBe(false);
    expect(shouldRunMaintenance(String(clock), clock + 86_400_001)).toBe(true);
  });
});

describe('terminal kaydı', () => {
  it('log satırları saklanır ve geri okunur', () => {
    storage.logs.append('run1', [
      { id: 'l1', ts: clock, level: 'seed', msg: 'Tohum alındı: test' },
      { id: 'l2', ts: clock + 1, level: 'rate', msg: 'Mola: login_required — 45 dk' },
    ]);

    const lines = storage.logs.listForRun('run1');
    expect(lines).toHaveLength(2);
    // Video olmayan olaylar yalnızca burada: gözlem tablosunda karşılıkları yok.
    expect(lines[1]?.level).toBe('rate');
    expect(lines[1]?.msg).toContain('Mola');
  });

  it('boş paket yazılmaz', () => {
    storage.logs.append('run2', []);
    expect(storage.logs.countForRun('run2')).toBe(0);
  });
});
