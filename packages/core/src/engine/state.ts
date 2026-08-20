import type { EnginePhase, StopReason } from '@hype/shared';

/** Duraklama ve cooldown sonrası hangi işe dönüleceğini bilen fazlar. */
export type ResumablePhase = 'seeding' | 'crawling';

export type EngineState =
  | { phase: 'idle' }
  | { phase: 'seeding'; attempt: number }
  | { phase: 'crawling' }
  | { phase: 'cooldown'; until: number; level: number; prior: ResumablePhase }
  | { phase: 'paused'; prior: ResumablePhase }
  | { phase: 'stopping' }
  | { phase: 'stopped'; reason: StopReason };

/**
 * Meşru geçişler. XState yerine elle yazılmış tablo: yedi durum ve bir düzine
 * geçiş için ek bağımlılık ve öğrenme maliyeti, kazandırdığı güvenliğin çok
 * üstünde olurdu. Tablo + exhaustive switch aynı korumayı sağlıyor.
 */
const LEGAL: Record<EnginePhase, readonly EnginePhase[]> = {
  idle: ['seeding', 'stopping'],
  seeding: ['crawling', 'seeding', 'cooldown', 'paused', 'stopping'],
  crawling: ['seeding', 'crawling', 'cooldown', 'paused', 'stopping'],
  cooldown: ['seeding', 'crawling', 'paused', 'stopping'],
  paused: ['seeding', 'crawling', 'cooldown', 'stopping'],
  stopping: ['stopped'],
  stopped: ['idle'],
};

export function canTransition(from: EnginePhase, to: EnginePhase): boolean {
  return LEGAL[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(from: EnginePhase, to: EnginePhase) {
    super(`Geçersiz durum geçişi: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Cooldown ve duraklamadan çıkarken dönülecek faz. */
export function resumableOf(state: EngineState): ResumablePhase {
  switch (state.phase) {
    case 'crawling':
      return 'crawling';
    case 'cooldown':
    case 'paused':
      return state.prior;
    default:
      return 'seeding';
  }
}
