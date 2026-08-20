import type { DomainEvent, EventEnvelope } from '@hype/shared';
import type { Clock } from '../ports/clock.js';

export type EventListener = (envelope: EventEnvelope) => void;

/**
 * Motorun tek çıkış kanalı. Üç abone dinler: WebSocket yayıncısı, kalıcılık
 * yazıcısı ve konsol log'u.
 *
 * Dağıtım hata-izoleli: patlayan bir abone ne motoru ne de diğer aboneleri
 * etkiler. Aksi hâlde WebSocket'teki bir hata, saatlerdir süren bir taramayı
 * öldürebilirdi.
 */
export class TypedEventBus {
  private listeners = new Set<EventListener>();
  private seq = 0;
  private onListenerError?: (error: unknown) => void;

  constructor(
    private readonly clock: Clock,
    onListenerError?: (error: unknown) => void,
  ) {
    if (onListenerError !== undefined) this.onListenerError = onListenerError;
  }

  get lastSeq(): number {
    return this.seq;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(runId: string | null, event: DomainEvent): EventEnvelope {
    const envelope: EventEnvelope = {
      seq: ++this.seq,
      ts: this.clock.now(),
      runId,
      event,
    };
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.onListenerError?.(error);
      }
    }
    return envelope;
  }
}
