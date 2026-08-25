import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from '@hype/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage, type Storage } from './index.js';
import { createPersistenceSubscriber } from './subscriber.js';

let storage: Storage | null = null;
let dir: string | null = null;

afterEach(() => {
  storage?.close();
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  storage = null;
  dir = null;
});

describe('kalıcılık abonesi', () => {
  it('eşik altında kalan adayın skor makbuzunu saklar', () => {
    dir = mkdtempSync(join(tmpdir(), 'hype-subscriber-'));
    storage = createStorage({ path: join(dir, 'test.db'), appVersion: '0.1.0' });
    const persist = createPersistenceSubscriber(storage);
    const envelope: EventEnvelope = {
      seq: 1,
      ts: 1_754_500_000_000,
      runId: 'run1',
      event: {
        type: 'video_skipped',
        videoId: 'vid_low',
        title: 'Eşiğin altındaki video',
        stage: 'score',
        reason: 'below_threshold',
        metrics: {
          views: 20_000,
          ageDays: 30,
          vpd: 666,
          channelId: 'UC_low',
          score: {
            scoreType: 'hype',
            hype: 2.4,
            vsr: null,
            z: 1.1,
            projectedViews: 20_000,
            baselineMedian: 8_333,
            baselineN: 8,
            baselineSamples: [8_000, 8_333, 9_000],
            lowConfidence: false,
            lowConfidenceReasons: [],
            channelIsHot: false,
          },
        },
      },
    };

    persist(envelope);
    storage.observations.flush();

    const details = storage.observations.listForRun('run1')[0]?.details;
    expect(details?.score).toMatchObject({
      scoreType: 'hype',
      hype: 2.4,
      baselineMedian: 8_333,
      baselineN: 8,
    });
  });
});
