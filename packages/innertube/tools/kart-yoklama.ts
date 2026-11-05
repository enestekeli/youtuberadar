/**
 * Kart yoklaması — "izlenme/tarih neden boş geliyor?" teşhisi.
 *
 * Aynı aramayı iki kimlikle yapar: taramanın kalıcı misafir kimliği
 * (`data/hype.db` → app_state.visitor_data) ve sıfırdan yeni bir misafir.
 * Kartların kaçında izlenme ve yaş okunabildiğini yan yana basar.
 *   - kalıcı kimlik boş, yeni kimlik dolu → kimlik sessizce kısıtlanmış
 *   - ikisi de boş → YouTube biçimi değişmiş (ya da IP kısıtlı)
 *
 * Toplam 2 arama isteği atar. Kullanım (depo kökünden):
 *   node node_modules/tsx/dist/cli.mjs packages/innertube/tools/kart-yoklama.ts [sorgu]
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { KvRepo } from '@hype/core';
import { systemClock, systemRng, systemSleeper } from '@hype/core';
import { createInnertubeAdapter } from '../src/index.js';

const DB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'hype.db');
const query = process.argv[2] ?? 'ancient technology explained';

function persistedKv(): KvRepo {
  const values = new Map<string, string>();
  if (existsSync(DB)) {
    const db = new DatabaseSync(DB, { readOnly: true });
    for (const row of db.prepare('SELECT key, value FROM app_state').all() as unknown as {
      key: string;
      value: string;
    }[]) {
      values.set(row.key, row.value);
    }
    db.close();
  }
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set() {
      /* salt okunur: taramanın kimliğine dokunma */
    },
  };
}

const freshKv: KvRepo = {
  async get() {
    return null;
  },
  async set() {},
};

async function probe(label: string, kv: KvRepo): Promise<void> {
  const { gateway } = createInnertubeAdapter({
    kv,
    clock: systemClock,
    sleeper: systemSleeper,
    rng: systemRng,
  });
  const cards = await gateway.fetchSearchFeed(query, new AbortController().signal);
  const videos = cards.filter((c) => c.kind === 'video');
  const views = videos.filter((c) => c.viewsApprox !== null).length;
  const age = videos.filter((c) => c.publishedAgeDays !== null).length;
  const dur = videos.filter((c) => c.durationSec !== null).length;
  console.log(
    `${label.padEnd(16)} ${videos.length} video | izlenme ${views} | yaş ${age} | süre ${dur} | kanal ${videos.filter((c) => c.channelId !== null).length}`,
  );
  const seed = videos.find((c) => (c.viewsApprox ?? 0) > 10_000) ?? videos[0];
  if (seed !== undefined) {
    const page = await gateway.fetchWatchNext(seed.videoId, new AbortController().signal);
    const rel = page.cards.filter((c) => c.kind === 'video');
    const types = new Map<string, number>();
    for (const c of rel) types.set(c.sourceNodeType, (types.get(c.sourceNodeType) ?? 0) + 1);
    console.log(
      `   öneri rafı (${seed.videoId}): ${rel.length} video | izlenme ${rel.filter((c) => c.viewsApprox !== null).length} | yaş ${rel.filter((c) => c.publishedAgeDays !== null).length} | süre ${rel.filter((c) => c.durationSec !== null).length} | tipler ${JSON.stringify(Object.fromEntries(types))}`,
    );
    for (const c of rel.slice(0, 3))
      console.log(
        `     ${c.title.slice(0, 50).padEnd(50)} ${String(c.viewsApprox).padStart(9)} ${String(c.publishedAgeDays)}`,
      );
  }
  for (const c of videos.slice(0, 3)) {
    console.log(
      `   ${c.title.slice(0, 50).padEnd(50)} ${String(c.viewsApprox).padStart(9)} ${String(c.publishedAgeDays?.toFixed(1)).padStart(6)}  [${c.sourceNodeType}]`,
    );
  }
}

console.log(`Sorgu: "${query}"`);
await probe('kalıcı kimlik', persistedKv());
await probe('yeni misafir', freshKv);
