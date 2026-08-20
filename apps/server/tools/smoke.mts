/**
 * Canlı duman testi.
 *
 * Çalışan sunucuya WebSocket'ten bağlanır, küçük bütçeli gerçek bir tarama
 * başlatır ve akışı terminale basar. Amaç yığının tamamını — hız yönetimi,
 * ayrıştırma, skorlama, kalıcılık, olay yayını — tek seferde gerçek YouTube'a
 * karşı doğrulamak.
 *
 * Kullanım: npx tsx apps/server/tools/smoke.mts [sorgu] [saniye]
 */
const BASE = process.env.HYPE_URL ?? 'http://127.0.0.1:5178';
const query = process.argv[2] ?? 'belgesel';
const seconds = Number.parseInt(process.argv[3] ?? '150', 10);

const defaults = await (await fetch(`${BASE}/api/config/defaults`)).json();
const config = {
  ...defaults,
  maxVideosScanned: 60,
  maxDepth: 3,
  requestBudget: 100,
  channelRequestBudget: 20,
  seedQueries: [query],
};

const socket = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
const counts: Record<string, number> = {};
let matched = 0;
let lastStats: Record<string, unknown> | null = null;

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ type: 'resume', epochId: null, fromSeq: null }));
});

socket.addEventListener('message', (message) => {
  const event = JSON.parse(String(message.data));
  counts[event.type] = (counts[event.type] ?? 0) + 1;

  if (event.type === 'log') {
    for (const line of event.lines) {
      const tag = line.level.toUpperCase().padEnd(7);
      console.log(`  ${tag} ${line.msg}`);
    }
  }
  if (event.type === 'pool:update') matched += 1;
  if (event.type === 'stats') lastStats = event.stats;
  if (event.type === 'fatal') console.error('ÖLÜMCÜL:', event.message);
});

const started = await fetch(`${BASE}/api/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config }),
});
if (!started.ok) {
  console.error('tarama başlatılamadı:', started.status, await started.text());
  process.exit(1);
}
console.log(`Tarama başladı ("${query}"), ${seconds} sn izleniyor…\n`);

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
await fetch(`${BASE}/api/runs/current/stop`, { method: 'POST' });
await new Promise((resolve) => setTimeout(resolve, 3000));

console.log('\n=== ÖZET ===');
console.log('olay sayıları:', counts);
console.log('skorlanan kart:', matched);
if (lastStats !== null) {
  console.log('huni:', JSON.stringify(lastStats, null, 2).slice(0, 900));
}

const pool = await (await fetch(`${BASE}/api/videos?limit=10`)).json();
console.log(`\nhavuz: ${pool.items.length} video`);
for (const item of pool.items) {
  const score = item.score.type === 'pending' ? 'bekliyor' : `${item.score.value.toFixed(1)}x`;
  console.log(
    `  ${score.padStart(9)}  ${item.channelName ?? '?'} — ${item.title.slice(0, 55)} (${item.views} izlenme)`,
  );
}
socket.close();
