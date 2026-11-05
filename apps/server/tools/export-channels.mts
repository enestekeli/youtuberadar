/**
 * Kanal listesini dışa aktarır — `exports/kanallar-<tarih>.csv` + `.html`.
 *
 * Her kanal TEK satır; ölçümler uzun videolardan (≥ 8 dk), durum (referans /
 * aday / izlemede / elendi + sebep) `src/kanal-listesi.ts` kurallarıyla.
 * Kurallar `@hype/shared` `bizim-sistem.ts`'te.
 *
 * Akış (eski sistemle aynı):
 *   1. Tarama → `export.cmd` (ya da bu betik).
 *   2. Puanlanmamış kanallar `exports/siniflama-girdi.json`'a yazılır.
 *   3. Claude o dosyaya bakıp `exports/siniflama.json`'a kanal kimliğiyle
 *      kategori / alt_nis / uretilebilirlik / formul_benzerligi / gorsel_tipi /
 *      politika_riski / not yazar. Eleme turları `not` alanına etiketlenir
 *      (ör. "[2026-11-05 eleme]") — geri almak için o etiketli girdiler silinir.
 *   4. Betik yeniden çalıştırılır; puanlar ve elemeler listeye işlenir.
 *
 * Hiçbir istek atmaz; tarama sürerken de çalıştırılabilir.
 *
 * Kullanım (depo kökünden, Bash ya da export.cmd):
 *   node node_modules/tsx/dist/cli.mjs apps/server/tools/export-channels.mts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@hype/db';
import { CATEGORIES, RawVideoCardSchema } from '@hype/shared';
import { z } from 'zod';
import {
  type ChannelInput,
  type ChannelRow,
  type Classification,
  ClassificationSchema,
  classificationInput,
  crowding,
  evaluateChannel,
  sortRows,
} from '../src/kanal-listesi.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PATH = process.env.HYPE_DB ?? resolve(REPO_ROOT, 'data/hype.db');
const OUT_DIR = resolve(REPO_ROOT, 'exports');
const CLASSIFICATION_PATH = resolve(OUT_DIR, 'siniflama.json');

function loadClassification(): Record<string, Classification> {
  if (!existsSync(CLASSIFICATION_PATH)) return {};
  try {
    return ClassificationSchema.parse(JSON.parse(readFileSync(CLASSIFICATION_PATH, 'utf8')));
  } catch (error) {
    // Bozuk dosya puanları SESSİZCE silmesin: dur ve söyle.
    console.error(`siniflama.json okunamadı — düzeltmeden export yapılmadı:\n${String(error)}`);
    process.exit(1);
  }
}

interface DbRow {
  channel_id: string;
  channel_name: string | null;
  v_subs: number | null;
  channel_age_days: number | null;
  caught_at: number;
  seed_query: string | null;
  name: string | null;
  handle: string | null;
  c_subs: number | null;
  country: string | null;
  joined_at: number | null;
  uploads_json: string | null;
  snapshot_fetched_at: number | null;
}

function loadChannels(): ChannelInput[] {
  if (!existsSync(DB_PATH)) {
    console.error(`Veritabanı yok: ${DB_PATH}\nÖnce baslat.cmd ile bir tarama yapın.`);
    process.exit(1);
  }
  const handle = openDatabase(DB_PATH);
  try {
    const rows = handle.raw
      .prepare(
        `SELECT v.channel_id, v.channel_name, v.subs_approx AS v_subs, v.channel_age_days,
                v.caught_at, v.seed_query,
                c.name, c.handle, c.subs_approx AS c_subs, c.country, c.joined_at,
                c.uploads_json, c.snapshot_fetched_at
           FROM videos v LEFT JOIN channels c ON c.channel_id = v.channel_id
          WHERE v.status != 'discarded'
          ORDER BY v.caught_at DESC`,
      )
      .all() as DbRow[];
    const uploadsSchema = z.array(RawVideoCardSchema);
    const seen = new Set<string>();
    const out: ChannelInput[] = [];
    for (const row of rows) {
      if (seen.has(row.channel_id)) continue; // en yeni yakalama kalır
      seen.add(row.channel_id);
      let uploads: ChannelInput['uploads'] = [];
      if (row.uploads_json !== null) {
        const parsed = uploadsSchema.safeParse(JSON.parse(row.uploads_json));
        if (parsed.success) uploads = parsed.data;
      }
      out.push({
        channelId: row.channel_id,
        name: row.name || row.channel_name || row.channel_id,
        handle: row.handle,
        subs: row.c_subs ?? row.v_subs,
        country: row.country,
        joinedAt: row.joined_at,
        channelAgeDaysAtCatch: row.channel_age_days,
        caughtAt: row.caught_at,
        snapshotFetchedAt: row.snapshot_fetched_at,
        uploads,
        seedQuery: row.seed_query,
      });
    }
    return out;
  } finally {
    handle.close();
  }
}

// ------------------------------------------------------------------ biçim
const fmtInt = (n: number | null) => (n === null ? '' : String(Math.round(n)));
const fmtDec = (n: number | null, digits = 2) =>
  n === null ? '' : n.toFixed(digits).replace('.', ',');
function cell(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}
function compact(n: number | null): string {
  if (n === null) return '–';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (n >= 1000) return `${Math.round(n / 1000)} B`;
  return String(Math.round(n));
}
const stampDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const HEADER = [
  'durum',
  'durum_sebebi',
  'işaretler',
  'Kanal',
  'Kanal linki',
  'dil',
  'ülke',
  'kanal yaşı (gün)',
  'abone',
  'uzun video sayısı',
  'son 30 gün yükleme',
  'son10 uzun medyan',
  'ivme (son5/önceki5)',
  'medyan süre (dk)',
  'süre uyumu',
  'En çok izlenen uzun video',
  'En iyi izlenme',
  'En iyi video linki',
  'kategori',
  'alt_nis',
  'aynı alt nişte kanal',
  'uretilebilirlik (0-5, görsel tavanlı)',
  'formul_benzerligi (0-5)',
  'gorsel_tipi',
  'öncelik (0-12)',
  'Not',
  'Yürüyüşün başladığı arama (kanalın konusu DEĞİL)',
  'Yakalanma',
];

function csvCells(row: ChannelRow, crowd: Map<string, number>): string[] {
  const c = row.classification;
  const niche = c?.alt_nis?.trim().toLocaleLowerCase('tr') ?? '';
  return [
    row.status,
    row.reason,
    row.flags.join(', '),
    row.name,
    row.link,
    row.language,
    row.country ?? '',
    fmtInt(row.ageDays),
    fmtInt(row.subs),
    String(row.longCount),
    String(row.uploads30),
    fmtInt(row.medianRecent),
    fmtDec(row.momentum),
    fmtInt(row.medianDurationMin),
    row.durationFit,
    row.best?.title ?? '',
    fmtInt(row.best?.views ?? null),
    row.best === null ? '' : `https://www.youtube.com/watch?v=${row.best.videoId}`,
    c?.kategori ?? '',
    c?.alt_nis ?? '',
    niche === '' ? '' : String(crowd.get(niche) ?? 0),
    row.producibility === null ? '' : String(row.producibility),
    c === null ? '' : String(c.formul_benzerligi),
    c?.gorsel_tipi ?? '',
    row.priority === null ? '' : String(row.priority),
    c?.not ?? '',
    row.seedQuery ?? '',
    new Date(row.caughtAt).toISOString().slice(0, 16).replace('T', ' '),
  ];
}

function renderHtml(rows: ChannelRow[], crowd: Map<string, number>, stamp: string): string {
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const body = rows
    .map((r) => {
      const c = r.classification;
      const niche = c?.alt_nis?.trim().toLocaleLowerCase('tr') ?? '';
      const thumb =
        r.best === null
          ? ''
          : `<a href="https://www.youtube.com/watch?v=${esc(r.best.videoId)}" target="_blank"><img loading="lazy" alt="en iyi video" src="https://i.ytimg.com/vi/${esc(r.best.videoId)}/mqdefault.jpg" alt=""></a>`;
      return `<tr class="s-${r.status}" data-status="${r.status}">
<td><b class="st">${r.status}</b><div class="why">${esc(r.reason)}</div>${r.flags.length > 0 ? `<div class="fl">${esc(r.flags.join(' · '))}</div>` : ''}</td>
<td class="ch"><a href="${esc(r.link)}" target="_blank">${esc(r.name)}</a><div class="meta">${esc(r.language)} · ${r.ageDays === null ? '?' : Math.round(r.ageDays)} gün · ${compact(r.subs)} abone</div></td>
<td class="num">${compact(r.medianRecent)}<div class="meta">${r.longCount} uzun · 30g ${r.uploads30}</div></td>
<td class="num">${r.momentum === null ? '–' : fmtDec(r.momentum, 1)}</td>
<td class="num">${r.medianDurationMin === null ? '–' : Math.round(r.medianDurationMin)} dk<div class="meta">${r.durationFit}</div></td>
<td class="best">${thumb}<div>${esc(r.best?.title ?? '')}</div><div class="meta">${compact(r.best?.views ?? null)}</div></td>
<td>${esc(c?.kategori ?? '—')}<div class="meta">${esc(c?.alt_nis ?? '')}${niche !== '' ? ` (${crowd.get(niche) ?? 0} kanal)` : ''}</div></td>
<td class="num">${r.producibility ?? '–'} / ${c?.formul_benzerligi ?? '–'}<div class="meta">${esc(c?.gorsel_tipi ?? '')}${r.priority !== null ? ` · öncelik ${r.priority}` : ''}</div></td>
<td class="note">${esc(c?.not ?? '')}</td>
</tr>`;
    })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><title>Kanal listesi ${stamp}</title>
<style>
body{font:13px/1.4 system-ui,sans-serif;margin:16px;background:#fafafa;color:#222}
h1{font-size:18px;margin:0 0 8px}
.bar{margin:8px 0 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.bar button{border:1px solid #bbb;background:#fff;padding:4px 10px;border-radius:4px;cursor:pointer}
.bar button.on{background:#222;color:#fff;border-color:#222}
.bar input{padding:4px 8px;border:1px solid #bbb;border-radius:4px;min-width:240px}
table{border-collapse:collapse;width:100%;background:#fff}
td,th{border-bottom:1px solid #e3e3e3;padding:6px 8px;vertical-align:top;text-align:left}
th{position:sticky;top:0;background:#f0f0f0;font-weight:600}
.num{text-align:right;white-space:nowrap}
.meta,.why,.fl{color:#777;font-size:11px}
.fl{color:#a55}
.best img{width:160px;display:block;border-radius:3px}
.best{max-width:220px}.note{max-width:320px;font-size:12px}.ch{max-width:200px}
.s-aday .st{color:#0a7d2c}.s-izlemede .st{color:#b07400}.s-elendi .st{color:#999}.s-referans .st{color:#2357c4}
.s-elendi{opacity:.55}
</style></head><body>
<h1>Kanal listesi — bizim sistem · ${stamp}</h1>
<div class="meta">${rows.length} kanal · referans ${count('referans')} · aday ${count('aday')} · izlemede ${count('izlemede')} · elendi ${count('elendi')}. Ölçümler ≥ 8 dk videolardan; durum kuralları kanal-listesi.ts.</div>
<div class="bar">
<button type="button" data-f="all">hepsi</button><button type="button" data-f="aday" class="on">aday</button><button type="button" data-f="izlemede">izlemede</button><button type="button" data-f="elendi">elendi</button><button type="button" data-f="referans">referans</button>
<input id="q" placeholder="ara: kanal, başlık, alt niş, not…">
</div>
<table><thead><tr><th>durum</th><th>kanal</th><th>son10 medyan</th><th>ivme</th><th>süre</th><th>en iyi video</th><th>kategori / alt niş</th><th>ürt / formül</th><th>not</th></tr></thead>
<tbody>
${body}
</tbody></table>
<script>
let f='aday';const q=document.getElementById('q');
function apply(){const t=q.value.toLowerCase();for(const tr of document.querySelectorAll('tbody tr')){const ok=(f==='all'||tr.dataset.status===f)&&(!t||tr.textContent.toLowerCase().includes(t));tr.style.display=ok?'':'none';}}
for(const b of document.querySelectorAll('.bar button')){b.onclick=()=>{f=b.dataset.f;for(const x of document.querySelectorAll('.bar button'))x.classList.toggle('on',x===b);apply();};}
q.oninput=apply;apply();
</script>
</body></html>`;
}

// ------------------------------------------------------------------ ana akış
const now = Date.now();
const classification = loadClassification();
const known: ReadonlySet<string> = new Set(CATEGORIES);
const unknownCategories = new Set(
  Object.values(classification)
    .map((c) => c.kategori)
    .filter((k) => !known.has(k)),
);
if (unknownCategories.size > 0)
  console.warn(`Tanımsız kategori: ${[...unknownCategories].join(', ')}`);

const rows = sortRows(
  loadChannels().map((ch) => evaluateChannel(ch, classification[ch.channelId], now)),
);
const crowd = crowding(rows);

mkdirSync(OUT_DIR, { recursive: true });
const stamp = stampDate(new Date(now));
const csvPath = resolve(OUT_DIR, `kanallar-${stamp}.csv`);
const lines = [
  HEADER.map(cell).join(';'),
  ...rows.map((r) => csvCells(r, crowd).map(cell).join(';')),
];
writeFileSync(csvPath, `﻿${lines.join('\r\n')}\r\n`, 'utf8');
const htmlPath = resolve(OUT_DIR, `kanallar-${stamp}.html`);
writeFileSync(htmlPath, renderHtml(rows, crowd, stamp), 'utf8');

const pending = rows
  .filter((r) => r.status !== 'referans' && classification[r.channelId] === undefined)
  .map(classificationInput);
writeFileSync(resolve(OUT_DIR, 'siniflama-girdi.json'), JSON.stringify(pending, null, 1), 'utf8');

const count = (s: ChannelRow['status']) => rows.filter((r) => r.status === s).length;
console.log(csvPath);
console.log(htmlPath);
console.log(
  `${rows.length} kanal | referans ${count('referans')} | aday ${count('aday')} | izlemede ${count('izlemede')} | elendi ${count('elendi')} | puanlanmayı bekleyen ${pending.length}`,
);
