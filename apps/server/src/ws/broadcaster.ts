import type { ServerEvent, SnapshotState } from '@hype/shared';
import { PROTOCOL_VERSION } from '@hype/shared';

export interface Socket {
  send(data: string): void;
  readyState: number;
}

const OPEN = 1;

/** Yeniden bağlanan istemcinin boşluğu kapatabileceği olay tamponu. */
export const REPLAY_BUFFER_SIZE = 5000;

/**
 * Zarfsız olay. `Omit` birleşim tipleri üzerinde dağılmadığı için (tüm
 * varyantları tek bir nesneye ezerdi) dağıtıcı biçim gerekiyor.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type OutboundEvent = DistributiveOmit<ServerEvent, 'seq' | 'ts'>;

/**
 * WebSocket yayıncısı.
 *
 * Akış tek yönlü: sunucudan istemciye olaylar, istemciden sunucuya yalnızca
 * `resume` ve `ping`. Komutlar REST'te — çünkü komutlar istek/yanıt semantiği,
 * HTTP durum kodu ve doğrulama hatası gövdesi istiyor; WebSocket bunların
 * hiçbirini bedava vermiyor.
 *
 * `epochId` + monoton `seq` ikilisi yeniden bağlanmayı çözer: aynı süreçse ve
 * boşluk tampona sığıyorsa kaçırılan olaylar tekrar oynatılır (arayüz hiç
 * titremez), aksi hâlde tam anlık görüntü gönderilir.
 */
export class Broadcaster {
  private readonly sockets = new Set<Socket>();
  private readonly buffer: ServerEvent[] = [];
  private seq = 0;

  constructor(
    readonly epochId: string,
    private readonly now: () => number,
  ) {}

  get currentSeq(): number {
    return this.seq;
  }

  get clientCount(): number {
    return this.sockets.size;
  }

  add(socket: Socket): void {
    this.sockets.add(socket);
  }

  remove(socket: Socket): void {
    this.sockets.delete(socket);
  }

  /** Olayı numaralandırır, tampona yazar ve bağlı herkese gönderir. */
  broadcast(event: OutboundEvent): ServerEvent {
    const stamped = { ...event, seq: ++this.seq, ts: this.now() } as ServerEvent;
    this.buffer.push(stamped);
    if (this.buffer.length > REPLAY_BUFFER_SIZE) this.buffer.shift();

    const payload = JSON.stringify(stamped);
    for (const socket of this.sockets) {
      this.deliver(socket, payload);
    }
    return stamped;
  }

  /** Tek bir sokete gönderir (hello / snapshot / replay). */
  sendTo(socket: Socket, event: OutboundEvent): void {
    const stamped = { ...event, seq: this.seq, ts: this.now() } as ServerEvent;
    this.deliver(socket, JSON.stringify(stamped));
  }

  /**
   * Yeni bağlantıyı karşılar.
   *
   * `fromSeq` null (sayfa yenilendi) ya da boşluk tampona sığmıyorsa tam anlık
   * görüntü; aksi hâlde yalnızca kaçırılanlar. Kart eklemeleri videoId anahtarlı
   * ve idempotent olduğu için tekrar oynatma çift kayıt üretemez.
   */
  resume(
    socket: Socket,
    fromSeq: number | null,
    epochId: string | null,
    buildSnapshot: () => SnapshotState,
  ): void {
    const sameEpoch = epochId === this.epochId;
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    const canReplay = sameEpoch && fromSeq !== null && fromSeq >= oldest - 1;

    if (!canReplay) {
      this.sendTo(socket, { type: 'snapshot', state: buildSnapshot() });
      return;
    }

    const missed = this.buffer.filter((e) => e.seq > fromSeq);
    for (const event of missed) {
      this.deliver(socket, JSON.stringify(event));
    }
    this.sendTo(socket, { type: 'resumeOk', replayed: missed.length });
  }

  greet(socket: Socket, status: SnapshotState['status'], activeRunId: string | null): void {
    this.sendTo(socket, {
      type: 'hello',
      epochId: this.epochId,
      protocolVersion: PROTOCOL_VERSION,
      status,
      activeRunId,
    });
  }

  private deliver(socket: Socket, payload: string): void {
    if (socket.readyState !== OPEN) {
      this.sockets.delete(socket);
      return;
    }
    try {
      socket.send(payload);
    } catch {
      // Ölü soket yayını durdurmamalı; bir sonraki turda zaten temizlenir.
      this.sockets.delete(socket);
    }
  }
}
