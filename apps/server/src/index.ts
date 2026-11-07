import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

/** Yerel araç: yalnızca loopback'e bağlanır, ağdan erişilemez. */
const HOST = '127.0.0.1';
/**
 * Kendi değişkenimiz — genel `PORT` bilinçli olarak okunmuyor: bazı geliştirme
 * araçları onu arayüz için ayarlıyor ve iki sunucu aynı porta çıkıyor.
 */
const PORT = Number.parseInt(process.env.HYPE_PORT ?? '5178', 10);

/**
 * Veritabanı her zaman depo kökünde. `process.cwd()` kullanılsaydı komutun
 * hangi dizinden çalıştırıldığına göre farklı veritabanları oluşurdu.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PATH = process.env.HYPE_DB ?? resolve(REPO_ROOT, 'data/hype.db');

async function main(): Promise<void> {
  const { app, ctx } = await createApp({
    dbPath: DB_PATH,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(process.env.NODE_ENV === 'production'
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }),
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'kapanıyor');
    // Tarama ortasında kapanırsak oturum "kesintiye uğradı" olarak kalır ve
    // arayüz bir sonraki açılışta "Devam et" sunar.
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: HOST, port: PORT });
  const autoResumed = ctx.autoResumeOnStartup();
  if (autoResumed !== null) {
    app.log.info({ runId: autoResumed }, 'sürekli tarama: 15 sn sonra kaldığı yerden sürecek');
  }
  app.log.info(
    {
      url: `http://${HOST}:${PORT}`,
      db: DB_PATH,
      resumable: ctx.storage.runs.findResumable()?.runId ?? null,
    },
    'Hype Radar hazır',
  );
}

main().catch((error: unknown) => {
  console.error('sunucu başlatılamadı:', error);
  process.exit(1);
});
