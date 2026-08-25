import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Match } from '@hype/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppContext } from './composition.js';

let dir: string;
let app: FastifyInstance;
let ctx: AppContext;

const match = (overrides: Partial<Match> = {}): Match => ({
  videoId: 'vid_hit',
  runId: 'run1',
  channelId: 'UC_small',
  title: 'Yakalanan video',
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hype-api-'));
  const created = await createApp({ dbPath: join(dir, 'api.db'), logger: false });
  app = created.app;
  ctx = created.ctx;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sağlık ve varsayılanlar', () => {
  it('sağlık motorun fazını ve hız yöneticisi durumunu bildirir', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enginePhase).toBe('idle');
    expect(body.activeRunId).toBeNull();
    expect(body.governor).toHaveProperty('lastHourTotal');
  });

  it('varsayılan yapılandırma yeni kanal radarı değerlerini döner', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/config/defaults' })).json();
    expect(body.maxDepth).toBe(4);
    expect(body.mode).toBe('channel');
    expect(body.maxChannelAgeDays).toBe(90);
    expect(body.minSubs).toBeNull();
    expect(body.hypeThreshold).toBe(5);
    expect(Array.isArray(body.seedQueries)).toBe(true);
  });
});

describe('geçmiş karar makbuzları', () => {
  it('run gözlemlerini skor ayrıntılarıyla döndürür', async () => {
    ctx.storage.observations.record({
      runId: 'run1',
      videoId: 'vid_low',
      channelId: 'UC_low',
      depth: 2,
      stage: 'score',
      verdict: 'below_threshold',
      details: { score: { scoreType: 'hype', hype: 2.4, baselineMedian: 10_000 } },
    });
    ctx.storage.observations.flush();

    const res = await app.inject({ method: 'GET', url: '/api/runs/run1/observations' });
    expect(res.statusCode).toBe(200);
    expect(res.json().observations[0].details.score.hype).toBe(2.4);
  });
});

describe('tarama başlatma doğrulaması', () => {
  it('geçersiz yapılandırma hangi alanın hatalı olduğunu söyler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: { minSubs: 90_000, maxSubs: 50_000 } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('aralık dışı derinlik reddedilir', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: { maxDepth: 99 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('çalışan tarama yokken durdurma isteği çakışma döner', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/current/stop' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_active_run');
  });

  it('devam noktası olmayan tarama için 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/olmayan/resume' });
    expect(res.statusCode).toBe(404);
  });
});

describe('havuz uç noktaları', () => {
  beforeEach(() => {
    ctx.storage.videos.saveMatch(match());
    ctx.storage.videos.saveMatch(
      match({ videoId: 'vid_low', hype: 3.1, title: 'Zayıf', channelIsHot: false }),
    );
  });

  it('havuz listelenir ve eşikle filtrelenir', async () => {
    const all = (await app.inject({ method: 'GET', url: '/api/videos' })).json();
    expect(all.items).toHaveLength(2);

    const strong = (await app.inject({ method: 'GET', url: '/api/videos?minHype=5' })).json();
    expect(strong.items.map((i: { videoId: string }) => i.videoId)).toEqual(['vid_hit']);
  });

  it('çöpe atma videoyu listeden çıkarır ama kaydı korur', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/videos/vid_hit/discard' });
    expect(res.statusCode).toBe(200);

    const pooled = (await app.inject({ method: 'GET', url: '/api/videos' })).json();
    expect(pooled.items.map((i: { videoId: string }) => i.videoId)).not.toContain('vid_hit');
    // Kayıt duruyor: bu video sonraki taramalarda bir daha yakalanmayacak.
    expect(ctx.storage.videos.getRow('vid_hit')?.status).toBe('discarded');
  });

  it('geri alma videoyu havuza döndürür', async () => {
    await app.inject({ method: 'POST', url: '/api/videos/vid_hit/discard' });
    await app.inject({ method: 'POST', url: '/api/videos/vid_hit/restore' });
    const pooled = (await app.inject({ method: 'GET', url: '/api/videos' })).json();
    expect(pooled.items.map((i: { videoId: string }) => i.videoId)).toContain('vid_hit');
  });

  it('olmayan video için 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/videos/yok/discard' });
    expect(res.statusCode).toBe(404);
  });

  it('yeniden tohumlama kuyruğa alınır', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/videos/vid_hit/reseed' });
    expect(res.statusCode).toBe(200);
    // Çalışan tarama yokken bile kabul edilir; sıradaki taramanın ilk tohumu olur.
    expect(res.json().queued).toBe(false);
  });
});

describe('gövdesiz komut istekleri', () => {
  /*
   * Tarayıcı bu uçlara gövde göndermeden "application/json" başlığıyla geliyordu
   * ve Fastify'ın varsayılan ayrıştırıcısı boş gövdeyi reddedip 500 üretiyordu:
   * Durdur/Duraklat/Çöpe at düğmeleri sessizce hiçbir şey yapmıyordu.
   * Bir komut asla content-type başlığı yüzünden kaybolmamalı.
   */
  const JSON_HEADER = { 'content-type': 'application/json' };

  it('boş gövde + json başlığı 500 üretmez', async () => {
    ctx.storage.videos.saveMatch(match());

    for (const url of [
      '/api/videos/vid_hit/discard',
      '/api/videos/vid_hit/restore',
      '/api/videos/vid_hit/reseed',
    ]) {
      const res = await app.inject({ method: 'POST', url, headers: JSON_HEADER });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('tarama komutları başlıkla da anlamlı yanıt döner', async () => {
    // Çalışan tarama yok: doğru cevap 409, "ayrıştırılamadı" değil.
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/current/stop',
      headers: JSON_HEADER,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_active_run');
  });

  it('bozuk JSON hâlâ reddedilir', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: JSON_HEADER,
      payload: '{bozuk',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('export köprüsü', () => {
  beforeEach(() => {
    ctx.storage.videos.saveMatch(match());
  });

  it('versiyonlu zarf üretir ve veri kalitesi uyarılarını taşır', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/export',
      payload: { videoIds: ['vid_hit'], enrich: false },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.count).toBe(1);
    const envelope = body.items[0];
    expect(envelope.schema).toBe('hype-radar.video.v1');
    expect(envelope.video.url).toContain('vid_hit');
    expect(envelope.scores.type).toBe('hype');
    expect(envelope.channel.subscriber_count_is_approx).toBe(true);
    // Yuvarlanmış abone sayısını kesinmiş gibi devretmek aşağı akışı yanıltır.
    expect(envelope.provenance.caveats.join(' ')).toContain('yuvarlan');
  });

  it('export kaydı denetim için saklanır ve durum güncellenir', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/export',
      payload: { videoIds: ['vid_hit'], enrich: false },
    });
    expect(ctx.storage.exports.countForVideo('vid_hit')).toBe(1);
    expect(ctx.storage.videos.getRow('vid_hit')?.status).toBe('exported');
  });

  it('çöpe atılmış videonun durumu export ile ezilmez', async () => {
    ctx.storage.videos.setStatus('vid_hit', 'discarded');
    await app.inject({
      method: 'POST',
      url: '/api/export',
      payload: { videoIds: ['vid_hit'], enrich: false },
    });
    expect(ctx.storage.videos.getRow('vid_hit')?.status).toBe('discarded');
  });

  it('hiçbiri bulunamazsa 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/export',
      payload: { videoIds: ['yok'], enrich: false },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('presetler', () => {
  it('yerleşikler listelenir', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/presets' })).json();
    expect(body.presets.length).toBeGreaterThanOrEqual(3);
  });

  it('kullanıcı preseti oluşturulur, güncellenir, silinir', async () => {
    const config = (await app.inject({ method: 'GET', url: '/api/config/defaults' })).json();

    const created = await app.inject({
      method: 'POST',
      url: '/api/presets',
      payload: { name: 'Türkçe belgesel', config: { ...config, seedQueries: ['belgesel'] } },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/presets/${id}`,
      payload: { name: 'Kendi ayarım', config },
    });
    expect(updated.json().name).toBe('Kendi ayarım');

    expect((await app.inject({ method: 'DELETE', url: `/api/presets/${id}` })).statusCode).toBe(
      200,
    );
  });

  it('yerleşik preset silinemez', async () => {
    const presets = (await app.inject({ method: 'GET', url: '/api/presets' })).json().presets;
    const builtin = presets[0];
    const res = await app.inject({ method: 'DELETE', url: `/api/presets/${builtin.id}` });
    expect(res.statusCode).toBe(409);
  });
});

describe('sunucu kapanışı', () => {
  it('kapanış, kullanıcının durdurmasıyla karıştırılmaz', async () => {
    // Kapanan bir sunucu taramayı "iptal edildi" diye işaretlerse "Devam et"
    // seçeneği kaybolur; kesinti olarak işaretlemek onu geri kazandırır.
    ctx.storage.runs.create(
      'run_kesinti',
      (await app.inject({ method: 'GET', url: '/api/config/defaults' })).json(),
      null,
    );
    expect(ctx.storage.runs.findResumable()).toBeNull();

    ctx.storage.runs.setStatus('run_kesinti', 'interrupted');
    expect(ctx.storage.runs.findResumable()?.runId).toBe('run_kesinti');
  });
});
