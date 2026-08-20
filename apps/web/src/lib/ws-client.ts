import { PROTOCOL_VERSION, type ServerEvent, ServerEventSchema } from '@hype/shared';

export type ConnectionState = 'connecting' | 'live' | 'resyncing' | 'offline';

export interface WsClientOptions {
  url: string;
  onEvent: (event: ServerEvent) => void;
  onState: (state: ConnectionState, retryInMs?: number) => void;
  onProtocolMismatch: (serverVersion: number) => void;
}

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 8000;
const HEARTBEAT_MS = 15_000;
const SILENCE_TIMEOUT_MS = 30_000;

/**
 * WebSocket istemcisi.
 *
 * socket.io yerine elle yazıldı: bu uygulamada localhost'a giden TEK bir soket
 * var ve zaten kendi yeniden senkronizasyon protokolümüz (epoch + seq) gerekli.
 * socket.io'nun kendi yeniden bağlanma mantığı bizimkiyle çakışırdı.
 *
 * `lastSeq` filigranı sayesinde tekrar oynatılan olaylar iki kez uygulanmaz;
 * sayfa tarama ortasında yenilense bile durum eksiksiz geri gelir.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private epochId: string | null = null;
  private lastSeq: number | null = null;
  private backoff = BACKOFF_START_MS;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: WsClientOptions) {}

  connect(): void {
    this.closed = false;
    this.options.onState('connecting');
    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.backoff = BACKOFF_START_MS;
      this.options.onState('resyncing');
      // Boşluk varsa sunucu yalnızca kaçırılanları oynatır; yoksa tam görüntü.
      this.send({ type: 'resume', epochId: this.epochId, fromSeq: this.lastSeq });
      this.startHeartbeat();
    });

    socket.addEventListener('message', (message) => {
      this.noteActivity();
      const parsed = ServerEventSchema.safeParse(safeJson(String(message.data)));
      // Bilinmeyen olay tipi yok sayılır: ileri uyumluluk, çökme değil.
      if (!parsed.success) return;
      this.apply(parsed.data);
    });

    socket.addEventListener('close', () => this.scheduleReconnect());
    socket.addEventListener('error', () => socket.close());
  }

  disconnect(): void {
    this.closed = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
  }

  private apply(event: ServerEvent): void {
    if (event.type === 'hello') {
      if (event.protocolVersion !== PROTOCOL_VERSION) {
        this.options.onProtocolMismatch(event.protocolVersion);
        return;
      }
      this.epochId = event.epochId;
      return;
    }

    if (event.type === 'snapshot') {
      this.epochId = event.state.epochId;
      this.lastSeq = event.state.seq;
      this.options.onEvent(event);
      this.options.onState('live');
      return;
    }

    if (event.type === 'resumeOk') {
      this.lastSeq = event.seq;
      this.options.onState('live');
      return;
    }

    // Filigran: aynı olay iki kez uygulanamaz.
    if (this.lastSeq !== null && event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    this.options.onEvent(event);
  }

  private send(frame: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private startHeartbeat(): void {
    this.clearTimers();
    // Tarayıcı WS ping çerçevesi gönderemez; canlılık uygulama düzeyinde.
    this.heartbeat = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS);
    this.noteActivity();
  }

  private noteActivity(): void {
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.socket?.close(), SILENCE_TIMEOUT_MS);
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    if (this.closed) return;

    const jitter = 0.7 + Math.random() * 0.6;
    const delay = Math.round(Math.min(this.backoff * jitter, BACKOFF_MAX_MS));
    this.options.onState('offline', delay);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.heartbeat = null;
    this.silenceTimer = null;
    this.retryTimer = null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
