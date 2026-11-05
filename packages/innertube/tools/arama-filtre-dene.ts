/**
 * Arama filtresi denemesi: aynı sorgu düz (alaka) ve "bu ay + izlenmeye göre"
 * filtreli aranır; kartların izlenme dağılımı yan yana basılır.
 * Sorgu başına 2 istek. Kullanım:
 *   node node_modules/tsx/dist/cli.mjs packages/innertube/tools/arama-filtre-dene.ts "sorgu" ["sorgu2" ...]
 */
import { Innertube, YT } from 'youtubei.js';

const queries = process.argv.slice(2);
if (queries.length === 0) queries.push('what if earth');

const yt = await Innertube.create({ lang: 'en', location: 'US', retrieve_player: false });

function parseViews(text: string | undefined): number | null {
  if (text === undefined) return null;
  const m = /(\d[\d.,]*)\s*([KMB])?/i.exec(text);
  if (m === null) return null;
  const n = Number.parseFloat((m[1] ?? '').replace(/,/g, ''));
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase() as 'K' | 'M' | 'B'] ?? 1;
  return Math.round(n * mult);
}

async function summarize(label: string, run: () => Promise<unknown>) {
  const res = (await run()) as { videos?: unknown[] };
  const vids = (res.videos ?? []) as {
    title?: { text?: string };
    view_count?: { text?: string };
    short_view_count?: { text?: string };
    published?: { text?: string };
    author?: { name?: string };
  }[];
  const views = vids.map((v) => parseViews(v.view_count?.text ?? v.short_view_count?.text));
  const over10k = views.filter((v) => v !== null && v >= 10_000).length;
  const channels = new Set(vids.map((v) => v.author?.name)).size;
  console.log(
    `  ${label.padEnd(22)} ${vids.length} video | ≥10 B: ${over10k} | ayrı kanal: ${channels}`,
  );
  for (const v of vids.slice(0, 4)) {
    console.log(
      `     ${(v.title?.text ?? '').slice(0, 48).padEnd(48)} ${(v.view_count?.text ?? '').padEnd(16)} ${v.published?.text ?? ''}  · ${v.author?.name ?? ''}`,
    );
  }
}

const FILTERS: [string, string][] = [
  ['hafta + en yeni (şimdiki)', 'CAISBAgDEAE='],
  ['ay + izlenme', 'CAMSBAgEEAE='],
  ['hafta + izlenme', 'CAMSBAgDEAE='],
];
for (const q of queries) {
  console.log(`
"${q}"`);
  for (const [label, params] of FILTERS) {
    await summarize(label, async () => {
      const response = await yt.actions.execute('/search', {
        query: q,
        params: encodeURIComponent(params),
      });
      return new YT.Search(yt.actions, response);
    });
  }
}
