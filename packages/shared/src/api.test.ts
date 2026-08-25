import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from './api.js';

describe('HealthResponseSchema', () => {
  it('sunucunun gerçek sağlık yanıtını kabul eder', () => {
    const result = HealthResponseSchema.safeParse({
      ok: true,
      dbOk: true,
      sessionReady: true,
      enginePhase: 'idle',
      activeRunId: null,
      version: '0.1.0',
      governor: { lastHourTotal: 0, lastHourClassB: 0, tokens: 3 },
      resumable: null,
    });

    expect(result.success).toBe(true);
  });
});
