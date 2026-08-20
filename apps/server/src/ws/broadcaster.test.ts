import type { ServerEvent, SnapshotState } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { Broadcaster, REPLAY_BUFFER_SIZE, type Socket } from './broadcaster.js';

class FakeSocket implements Socket {
  readonly sent: ServerEvent[] = [];
  readyState = 1;
  throwOnSend = false;

  send(data: string): void {
    if (this.throwOnSend) throw new Error('soket kapandı');
    this.sent.push(JSON.parse(data) as ServerEvent);
  }

  types(): string[] {
    return this.sent.map((e) => e.type);
  }
}

const snapshot = (): SnapshotState => ({
  epochId: 'epoch-1',
  seq: 0,
  status: 'crawling',
  activeRun: null,
  cooldownUntil: null,
  stats: null,
  pool: [],
  logTail: [],
});

function build() {
  let time = 1_754_500_000_000;
  const broadcaster = new Broadcaster('epoch-1', () => time++);
  return { broadcaster };
}

describe('yayıncı', () => {
  it('olayları numaralandırır ve bağlı herkese gönderir', () => {
    const { broadcaster } = build();
    const a = new FakeSocket();
    const b = new FakeSocket();
    broadcaster.add(a);
    broadcaster.add(b);

    broadcaster.broadcast({ type: 'pong' });
    broadcaster.broadcast({ type: 'pong' });

    expect(a.sent.map((e) => e.seq)).toEqual([1, 2]);
    expect(b.sent).toHaveLength(2);
  });

  it('kapanmış soket yayını durdurmaz ve listeden düşer', () => {
    const { broadcaster } = build();
    const dead = new FakeSocket();
    const alive = new FakeSocket();
    dead.throwOnSend = true;
    broadcaster.add(dead);
    broadcaster.add(alive);

    expect(() => broadcaster.broadcast({ type: 'pong' })).not.toThrow();
    expect(alive.sent).toHaveLength(1);
    expect(broadcaster.clientCount).toBe(1);
  });

  it('kapalı durumdaki soket temizlenir', () => {
    const { broadcaster } = build();
    const closed = new FakeSocket();
    closed.readyState = 3;
    broadcaster.add(closed);
    broadcaster.broadcast({ type: 'pong' });
    expect(broadcaster.clientCount).toBe(0);
  });
});

describe('yeniden bağlanma', () => {
  it('sayfa yenilendiğinde (imleç yok) tam anlık görüntü gönderilir', () => {
    const { broadcaster } = build();
    broadcaster.broadcast({ type: 'pong' });

    const socket = new FakeSocket();
    broadcaster.add(socket);
    broadcaster.resume(socket, null, null, snapshot);

    expect(socket.types()).toEqual(['snapshot']);
  });

  it('kısa kesintide yalnızca kaçırılanlar tekrar oynatılır', () => {
    const { broadcaster } = build();
    broadcaster.broadcast({ type: 'pong' }); // seq 1
    broadcaster.broadcast({ type: 'pong' }); // seq 2
    broadcaster.broadcast({ type: 'pong' }); // seq 3

    const socket = new FakeSocket();
    broadcaster.add(socket);
    broadcaster.resume(socket, 1, 'epoch-1', snapshot);

    // Arayüz hiç titremez: anlık görüntü yok, sadece 2 ve 3.
    expect(socket.sent.filter((e) => e.type === 'pong').map((e) => e.seq)).toEqual([2, 3]);
    expect(socket.types()).toContain('resumeOk');
    expect(socket.types()).not.toContain('snapshot');
  });

  it('sunucu yeniden başladıysa (farklı epoch) anlık görüntüye düşülür', () => {
    const { broadcaster } = build();
    broadcaster.broadcast({ type: 'pong' });

    const socket = new FakeSocket();
    broadcaster.add(socket);
    broadcaster.resume(socket, 1, 'eski-epoch', snapshot);

    expect(socket.types()).toEqual(['snapshot']);
  });

  it('boşluk tampona sığmıyorsa anlık görüntüye düşülür', () => {
    const { broadcaster } = build();
    for (let i = 0; i < REPLAY_BUFFER_SIZE + 10; i++) broadcaster.broadcast({ type: 'pong' });

    const socket = new FakeSocket();
    broadcaster.add(socket);
    broadcaster.resume(socket, 1, 'epoch-1', snapshot);

    expect(socket.types()).toEqual(['snapshot']);
  });

  it('tampon sabit boyutta kalır', () => {
    const { broadcaster } = build();
    for (let i = 0; i < REPLAY_BUFFER_SIZE + 100; i++) broadcaster.broadcast({ type: 'pong' });
    expect(broadcaster.currentSeq).toBe(REPLAY_BUFFER_SIZE + 100);

    // Eski olaylar düştüğü için en baştan tekrar oynatma mümkün değil.
    const socket = new FakeSocket();
    broadcaster.add(socket);
    broadcaster.resume(socket, 0, 'epoch-1', snapshot);
    expect(socket.types()).toEqual(['snapshot']);
  });

  it('karşılama protokol sürümünü taşır', () => {
    const { broadcaster } = build();
    const socket = new FakeSocket();
    broadcaster.greet(socket, 'idle', null);

    const hello = socket.sent[0];
    expect(hello?.type).toBe('hello');
    if (hello?.type !== 'hello') return;
    expect(hello.epochId).toBe('epoch-1');
    expect(hello.protocolVersion).toBeGreaterThan(0);
  });
});
