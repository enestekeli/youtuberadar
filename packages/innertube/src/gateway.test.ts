import { describe, expect, it } from 'vitest';
import { NEWEST_WEEKLY_VIDEO_SEARCH_PARAMS } from './gateway.js';

describe('channel discovery search params', () => {
  it('sorts newest weekly video results', () => {
    const bytes = Buffer.from(decodeURIComponent(NEWEST_WEEKLY_VIDEO_SEARCH_PARAMS), 'base64');

    // prioritize=2, nested uploadDate=3 and type=1
    expect([...bytes]).toEqual([0x08, 0x02, 0x12, 0x04, 0x08, 0x03, 0x10, 0x01]);
  });
});
