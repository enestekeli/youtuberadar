import {
  CHANNEL_RADAR_DEFAULT_CONFIG,
  ExportRequestSchema,
  StartRunRequestSchema,
  UpsertPresetSchema,
  VideosQuerySchema,
} from '@hype/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { APP_VERSION, type AppContext, RunConflictError } from './composition.js';
import { buildExportEnvelope } from './export-builder.js';

const VideoParams = z.object({ videoId: z.string().min(1) });
const RunParams = z.object({ runId: z.string().min(1) });
const PresetParams = z.object({ id: z.coerce.number().int() });

/**
 * REST yüzeyi.
 *
 * TÜM komutlar burada, WebSocket'te değil. Sebebi somut: bir taramayı
 * başlatmak doğrulama hatası döndürebilmeli (400 + hangi alan), çakışma
 * bildirebilmeli (409), ve istemci isteğinin sonucunu bekleyebilmeli.
 * WebSocket bunların hiçbirini bedava vermiyor; olay akışı olarak kalması
 * hem protokolü hem yeniden bağlanma mantığını sadeleştiriyor.
 */
export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------------------------------------------------------------- tarama

  r.post('/api/runs', { schema: { body: StartRunRequestSchema } }, async (request, reply) => {
    try {
      const runId = ctx.startRun(request.body.config, request.body.presetId ?? null);
      return reply.code(201).send({ runId });
    } catch (error) {
      if (error instanceof RunConflictError) {
        return reply.code(409).send({ error: 'run_active', message: error.message });
      }
      throw error;
    }
  });

  r.post('/api/runs/current/pause', async (_request, reply) => {
    if (!ctx.isBusy)
      return reply.code(409).send({ error: 'no_active_run', message: 'Çalışan tarama yok' });
    ctx.pause();
    return reply.send({ ok: true });
  });

  r.post('/api/runs/current/resume', async (_request, reply) => {
    ctx.resume();
    return reply.send({ ok: true });
  });

  r.post('/api/runs/current/stop', async (_request, reply) => {
    if (!ctx.isBusy)
      return reply.code(409).send({ error: 'no_active_run', message: 'Çalışan tarama yok' });
    ctx.stop();
    return reply.send({ ok: true });
  });

  /** Çökme sonrası kaldığı yerden devam. */
  r.post('/api/runs/:runId/resume', { schema: { params: RunParams } }, async (request, reply) => {
    try {
      const resumed = ctx.resumeRun(request.params.runId);
      if (!resumed) {
        return reply
          .code(404)
          .send({ error: 'no_snapshot', message: 'Bu tarama için devam noktası yok' });
      }
      return reply.send({ ok: true, runId: request.params.runId });
    } catch (error) {
      if (error instanceof RunConflictError) {
        return reply.code(409).send({ error: 'run_active', message: error.message });
      }
      throw error;
    }
  });

  r.get('/api/runs', async () => ({ runs: ctx.storage.runs.list() }));

  r.get('/api/runs/:runId', { schema: { params: RunParams } }, async (request, reply) => {
    const run = ctx.storage.runs.get(request.params.runId);
    if (run === null) return reply.code(404).send({ error: 'not_found', message: 'Tarama yok' });
    return reply.send({
      ...run,
      // Çalışan tarama için bellekteki sayaçlar daha taze: veritabanına 25 tikte
      // bir yazılıyor, oradan okumak "0 tarandı" gibi yanlış bir tablo verirdi.
      stats: ctx.liveStatsFor(request.params.runId) ?? run.stats,
      breakdown: ctx.storage.observations.verdictBreakdown(request.params.runId),
    });
  });

  /** Geçmiş bir taramanın terminal kaydı. */
  r.get('/api/runs/:runId/logs', { schema: { params: RunParams } }, async (request) => ({
    lines: ctx.storage.logs.listForRun(request.params.runId),
  }));

  /** Geçmiş run'ın karar makbuzları; eşik senaryolarını çevrimdışı analiz eder. */
  r.get('/api/runs/:runId/observations', { schema: { params: RunParams } }, async (request) => ({
    observations: ctx.storage.observations.listForRun(request.params.runId),
  }));

  // ----------------------------------------------------------------- havuz

  r.get('/api/videos', { schema: { querystring: VideosQuerySchema } }, async (request) =>
    ctx.storage.videos.list(request.query),
  );

  r.post(
    '/api/videos/:videoId/discard',
    { schema: { params: VideoParams } },
    async (request, reply) => {
      if (ctx.storage.videos.get(request.params.videoId) === null) {
        return reply.code(404).send({ error: 'not_found', message: 'Video havuzda değil' });
      }
      // Silme değil durum değişikliği: satır kalır ki video bir daha yakalanmasın.
      ctx.storage.videos.setStatus(request.params.videoId, 'discarded');
      ctx.broadcastPoolRemoval(request.params.videoId, 'discarded');
      return reply.send({ ok: true });
    },
  );

  r.post(
    '/api/videos/:videoId/restore',
    { schema: { params: VideoParams } },
    async (request, reply) => {
      const item = ctx.storage.videos.get(request.params.videoId);
      if (item === null) return reply.code(404).send({ error: 'not_found', message: 'Video yok' });
      ctx.storage.videos.setStatus(request.params.videoId, 'pooled');
      ctx.broadcastPoolRestore(request.params.videoId);
      return reply.send({ ok: true });
    },
  );

  r.post(
    '/api/videos/:videoId/reseed',
    { schema: { params: VideoParams } },
    async (request, reply) => {
      ctx.requestSeed(request.params.videoId);
      return reply.send({ ok: true, queued: ctx.isBusy });
    },
  );

  // ---------------------------------------------------------------- export

  r.post('/api/export', { schema: { body: ExportRequestSchema } }, async (request, reply) => {
    const { videoIds, destination, enrich } = request.body;
    const items = [];
    const missing: string[] = [];

    for (const videoId of videoIds) {
      const envelope = await ctx.buildExport(videoId, enrich);
      if (envelope === null) {
        missing.push(videoId);
        continue;
      }
      items.push(envelope);
      ctx.storage.exports.record({ videoId, destination, envelope, ok: true });
      // İlk başarılı export durumu değiştirir; kullanıcı çöpe attıysa dokunmaz.
      if (ctx.storage.videos.getRow(videoId)?.status === 'pooled') {
        ctx.storage.videos.setStatus(videoId, 'exported');
      }
    }

    if (items.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'Hiçbir video bulunamadı' });
    }
    return reply.send({ count: items.length, items, missing });
  });

  // -------------------------------------------------------------- presetler

  r.get('/api/presets', async () => ({ presets: ctx.storage.presets.list() }));

  r.post('/api/presets', { schema: { body: UpsertPresetSchema } }, async (request, reply) => {
    if (ctx.storage.presets.nameTaken(request.body.name)) {
      return reply.code(409).send({ error: 'name_taken', message: 'Bu isimde bir preset var' });
    }
    return reply.code(201).send(ctx.storage.presets.create(request.body));
  });

  r.put(
    '/api/presets/:id',
    { schema: { params: PresetParams, body: UpsertPresetSchema } },
    async (request, reply) => {
      if (ctx.storage.presets.nameTaken(request.body.name, request.params.id)) {
        return reply.code(409).send({ error: 'name_taken', message: 'Bu isimde bir preset var' });
      }
      const updated = ctx.storage.presets.update(request.params.id, request.body);
      if (updated === null)
        return reply.code(404).send({ error: 'not_found', message: 'Preset yok' });
      return reply.send(updated);
    },
  );

  r.delete('/api/presets/:id', { schema: { params: PresetParams } }, async (request, reply) => {
    if (!ctx.storage.presets.delete(request.params.id)) {
      return reply
        .code(409)
        .send({ error: 'builtin_preset', message: 'Yerleşik preset silinemez' });
    }
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- sağlık

  r.get('/api/health', async () => ({
    ok: true,
    dbOk: true,
    sessionReady: true,
    enginePhase: ctx.phase,
    activeRunId: ctx.activeRunId,
    version: APP_VERSION,
    governor: ctx.governorStats,
    resumable: ctx.storage.runs.findResumable()?.runId ?? null,
  }));

  /** Varsayılan yapılandırma — arayüz formunu doldurmak için. */
  r.get('/api/config/defaults', async () => CHANNEL_RADAR_DEFAULT_CONFIG);
}

export type { AppContext };
export { buildExportEnvelope };
