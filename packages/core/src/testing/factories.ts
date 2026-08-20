import type { ChannelSnapshot, RawVideoCard } from '@hype/shared';

/** Testlerde feed kartı üretmek için — yalnızca ilgilenilen alanlar yazılır. */
export function makeCard(overrides: Partial<RawVideoCard> = {}): RawVideoCard {
  return {
    videoId: 'vid_default',
    title: 'Test videosu',
    channelId: 'UC_test',
    channelName: 'Test Kanalı',
    kind: 'video',
    durationSec: 600,
    viewsApprox: 50_000,
    publishedAgeDays: 5,
    thumbnailUrl: 'https://i.ytimg.com/vi/x/mqdefault.jpg',
    sourceNodeType: 'CompactVideo',
    ...overrides,
  };
}

/** Kanalın geçmiş yüklemelerini üretir: en yeni en başta, `ageStepDays` aralıklı. */
export function makeUploads(
  views: readonly number[],
  opts: { startAgeDays?: number; ageStepDays?: number; kind?: RawVideoCard['kind'] } = {},
): RawVideoCard[] {
  const start = opts.startAgeDays ?? 10;
  const step = opts.ageStepDays ?? 7;
  return views.map((v, i) =>
    makeCard({
      videoId: `upload_${i}`,
      viewsApprox: v,
      publishedAgeDays: start + i * step,
      ...(opts.kind === undefined ? {} : { kind: opts.kind }),
    }),
  );
}

export function makeSnapshot(overrides: Partial<ChannelSnapshot> = {}): ChannelSnapshot {
  return {
    channelId: 'UC_test',
    name: 'Test Kanalı',
    handle: '@test',
    subsApprox: 12_000,
    subsText: '12.3K subscribers',
    subsHidden: false,
    country: null,
    recentUploads: [],
    fetchedAt: 1_754_500_000_000,
    ...overrides,
  };
}
