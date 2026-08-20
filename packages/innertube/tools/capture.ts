/**
 * Golden fixture yakalama aracı.
 *
 * Canlı YouTube'a bağlanıp ham InnerTube yanıtlarını `fixtures/` altına yazar.
 * Testlerde ASLA çalışmaz; elle çalıştırılır ve çıktısı depoya işlenir.
 *
 * Var oluş sebebi: kütüphane yükseltmeleri ve YouTube'un sessiz şema
 * değişiklikleri, incelenebilir bir diff'e dönüşsün. Fixture'ları yenileyip
 * testleri koşmak, "neyin değiştiğini" saatler süren tahmin yerine bir dosya
 * farkı olarak gösterir.
 *
 * Kullanım:
 *   pnpm --filter @hype/innertube capture
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KvRepo } from '@hype/core';
import { systemClock, systemRng, systemSleeper } from '@hype/core';
import { createInnertubeAdapter } from '../src/index.js';
import { installParserTelemetry } from '../src/parser-telemetry.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Yakalama tek seferlik: kimliği kalıcılaştırmaya gerek yok. */
const ephemeralKv: KvRepo = {
  async get() {
    return null;
  },
  async set() {
    /* yakalama oturumu kimliği saklamaz */
  },
};

async function save(name: string, data: unknown): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const path = join(FIXTURE_DIR, `${name}.json`);
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`  ✓ ${name}.json`);
}

async function main(): Promise<void> {
  const warnings: unknown[] = [];
  installParserTelemetry((warning) => warnings.push(warning));

  const { gateway } = createInnertubeAdapter({
    kv: ephemeralKv,
    clock: systemClock,
    sleeper: systemSleeper,
    rng: systemRng,
  });

  const controller = new AbortController();

  console.log('Ana sayfa deneniyor…');
  const home = await gateway.fetchHomeFeed(controller.signal);
  await save('home-feed', home);
  console.log(
    `  ${home.length} kart, ${home.filter((c) => c.kind === 'video').length} yatay video`,
  );

  let seed = home.find((c) => c.kind === 'video');

  if (seed === undefined) {
    // Beklenen durum: anonim ana sayfa video yerine "giriş yap" kartı döndürür.
    const query = process.argv[2] ?? 'documentary';
    console.log(`Ana sayfa boş — arama tohumuna geçiliyor ("${query}")…`);
    const results = await gateway.fetchSearchFeed(query, controller.signal);
    await save('search-feed', results);
    console.log(
      `  ${results.length} kart, ${results.filter((c) => c.kind === 'video').length} yatay video`,
    );
    seed = results.find((c) => c.kind === 'video');
  }

  if (seed === undefined) {
    console.error('Hiçbir kaynaktan yatay video alınamadı — kimlik kısıtlanmış olabilir.');
    process.exitCode = 1;
    return;
  }

  console.log(`Öneri rafı çekiliyor (${seed.videoId})…`);
  const watchNext = await gateway.fetchWatchNext(seed.videoId, controller.signal);
  await save('watch-next', watchNext);
  console.log(`  ${watchNext.cards.length} kart`);

  const withChannel = watchNext.cards.find((c) => c.channelId !== null);
  if (withChannel?.channelId != null) {
    console.log(`Kanal anlık görüntüsü çekiliyor (${withChannel.channelId})…`);
    const channel = await gateway.fetchChannelSnapshot(withChannel.channelId, controller.signal);
    await save('channel-snapshot', channel);
    console.log(`  ${channel.name}: ${channel.subsText ?? 'abone sayısı okunamadı'}`);
  }

  if (warnings.length > 0) {
    await save('parser-warnings', warnings);
    console.warn(`\n⚠ ${warnings.length} ayrıştırıcı uyarısı — YouTube şeması değişmiş olabilir.`);
  }

  console.log('\nTamamlandı.');
}

main().catch((error: unknown) => {
  console.error('Yakalama başarısız:', error);
  process.exitCode = 1;
});
