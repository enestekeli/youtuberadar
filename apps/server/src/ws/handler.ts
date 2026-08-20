import { ClientFrameSchema } from '@hype/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../composition.js';
import type { Socket } from './broadcaster.js';

/** Tarayıcı WS ping çerçevesi gönderemez; canlılık uygulama düzeyinde ölçülür. */
export const HEARTBEAT_TIMEOUT_MS = 45_000;

/**
 * WebSocket uç noktası.
 *
 * Bağlantı akışı: `hello` (sunucu) → `resume` (istemci) → ya tam anlık görüntü
 * ya da kaçırılan olayların tekrarı. Sayfa tarama ortasında yenilendiğinde
 * durum eksiksiz geri gelir; kısa bir ağ kesintisinde ise arayüz hiç
 * titremeden kaldığı yerden devam eder.
 */
export function registerWebSocket(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws', { websocket: true }, (socket) => {
    const client = socket as unknown as Socket;
    ctx.broadcaster.add(client);
    ctx.broadcaster.greet(client, ctx.phase, ctx.activeRunId);

    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.close();
        return;
      }
      alive = false;
    }, HEARTBEAT_TIMEOUT_MS);

    socket.on('message', (raw: Buffer | string) => {
      alive = true;
      const parsed = ClientFrameSchema.safeParse(safeJson(raw.toString()));
      if (!parsed.success) return;

      if (parsed.data.type === 'ping') {
        ctx.broadcaster.sendTo(client, { type: 'pong' });
        return;
      }
      ctx.broadcaster.resume(client, parsed.data.fromSeq, parsed.data.epochId, () =>
        ctx.buildSnapshot(),
      );
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      ctx.broadcaster.remove(client);
    });

    socket.on('error', () => {
      clearInterval(heartbeat);
      ctx.broadcaster.remove(client);
    });
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
