/**
 * Öneri rafındaki ilk LockupView düğümünün metadata kısmını basar — okuyucu
 * izlenme/tarih bulamadığında biçimin nereye taşındığını görmek için.
 * 1 istek. Kullanım: node node_modules/tsx/dist/cli.mjs packages/innertube/tools/lockup-dok.ts [videoId]
 */
import { Innertube } from 'youtubei.js';

const videoId = process.argv[2] ?? 'uVvLWbos0QM';
const yt = await Innertube.create({ lang: 'en', location: 'US', retrieve_player: false });
const info = await yt.getInfo(videoId);
const feed = (info.watch_next_feed ?? []) as unknown as { type: string }[];
const lockup = feed.find((n) => n.type === 'LockupView') as Record<string, unknown> | undefined;
if (lockup === undefined) {
  console.log('LockupView yok; tipler:', [...new Set(feed.map((n) => n.type))]);
} else {
  const seen = new WeakSet();
  console.log(
    JSON.stringify(
      lockup.metadata,
      (_k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[döngü]';
          seen.add(v);
        }
        return v;
      },
      1,
    ).slice(0, 6000),
  );
}
