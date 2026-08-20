import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { AppContext } from './composition.js';
import { registerRoutes } from './routes.js';
import { registerWebSocket } from './ws/handler.js';

export interface CreateAppOptions {
  dbPath: string;
  /** pino seçenekleri; testlerde `false` verilerek susturulur. */
  logger?: object | boolean;
}

export interface CreatedApp {
  app: FastifyInstance;
  ctx: AppContext;
}

export async function createApp(options: CreateAppOptions): Promise<CreatedApp> {
  const app = Fastify({ logger: options.logger ?? true });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  /*
   * Boş gövde, gövde beklemeyen bir uç için hata DEĞİLDİR.
   *
   * Komut uçlarımızın çoğu gövdesiz POST (durdur, duraklat, çöpe at). Varsayılan
   * ayrıştırıcı, content-type "application/json" ise boş gövdeyi reddediyor ve
   * istek 500'e düşüyordu. Başlığı istemcinin doğru göndermesine güvenmek yerine
   * sunucu bunu burada tolere ediyor: bir "Durdur" komutu asla başlık yüzünden
   * kaybolmamalı.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  const ctx = new AppContext({ dbPath: options.dbPath, logger: app.log });

  /**
   * Doğrulama hataları alan-alan geri döner. Kontrol paneli formunun hangi
   * girdinin neden reddedildiğini gösterebilmesi buna bağlı.
   */
  app.setErrorHandler((error, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: 'validation',
        message: 'Geçersiz istek',
        issues: error.validation.map((issue) => ({
          path: String(issue.instancePath ?? ''),
          message: issue.message ?? 'geçersiz',
        })),
      });
    }
    app.log.error({ err: error }, 'istek başarısız');
    const message = error instanceof Error ? error.message : 'Beklenmedik hata';
    return reply.code(500).send({ error: 'internal', message });
  });

  await app.register(websocket);
  registerRoutes(app, ctx);
  registerWebSocket(app, ctx);

  app.addHook('onClose', async () => {
    await ctx.close();
  });

  return { app, ctx };
}
