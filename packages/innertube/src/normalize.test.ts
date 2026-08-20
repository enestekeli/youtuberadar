import { describe, expect, it } from 'vitest';
import type { Helpers } from 'youtubei.js';
import { classifyKind, emptyFacts, factsToCard, SAFE_SHORTS_DURATION_SEC } from './node-facts.js';
import { normalizeNode, readFacts } from './normalize.js';

const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';

/** readFacts yapısal okuma yapar; düz nesneler gerçek düğümleri sadıkça temsil eder. */
function node(shape: Record<string, unknown>): Helpers.YTNode {
  return shape as unknown as Helpers.YTNode;
}

const compactVideo = () =>
  node({
    type: 'CompactVideo',
    video_id: 'dQw4w9WgXcQ',
    title: { text: 'Test videosu' },
    author: { id: CHANNEL_ID, name: 'Küçük Kanal' },
    view_count: { text: '1.2M views' },
    published: { text: '3 days ago' },
    length_text: { text: '12:34' },
    thumbnails: [
      { url: 'https://i.ytimg.com/vi/x/default.jpg', width: 120 },
      { url: 'https://i.ytimg.com/vi/x/maxresdefault.jpg', width: 1280 },
    ],
  });

describe('readFacts — klasik video düğümleri', () => {
  it('tüm alanları okur ve en yüksek çözünürlüklü kapağı seçer', () => {
    const card = normalizeNode(compactVideo());
    expect(card).not.toBeNull();
    expect(card?.videoId).toBe('dQw4w9WgXcQ');
    expect(card?.kind).toBe('video');
    expect(card?.channelId).toBe(CHANNEL_ID);
    expect(card?.channelName).toBe('Küçük Kanal');
    expect(card?.viewsApprox).toBe(1_200_000);
    expect(card?.publishedAgeDays).toBe(3);
    expect(card?.durationSec).toBe(754);
    expect(card?.thumbnailUrl).toContain('maxresdefault');
  });

  it('duration getter varsa süre metnine gerek kalmaz', () => {
    const facts = readFacts(
      node({ type: 'Video', video_id: 'abc12345678', duration: { seconds: 600 } }),
    );
    expect(facts.durationSec).toBe(600);
  });

  it('canlı yayın ve prömiyer işaretlenir', () => {
    expect(normalizeNode(node({ type: 'Video', video_id: 'a1', is_live: true }))?.kind).toBe(
      'live',
    );
    expect(normalizeNode(node({ type: 'Video', video_id: 'a2', is_upcoming: true }))?.kind).toBe(
      'upcoming',
    );
  });

  it('RichItem sarmalayıcısı açılır', () => {
    const wrapped = node({ type: 'RichItem', content: compactVideo() });
    const card = normalizeNode(wrapped);
    expect(card?.videoId).toBe('dQw4w9WgXcQ');
    expect(card?.kind).toBe('video');
  });

  it('geçersiz kanal kimliği uydurulmaz', () => {
    const card = normalizeNode(
      node({ type: 'Video', video_id: 'abc12345678', author: { id: 'bozuk', name: 'X' } }),
    );
    expect(card?.channelId).toBeNull();
  });
});

describe('readFacts — yeni LockupView ailesi', () => {
  it('metadata satırlarından kanal, izlenme ve yaş çıkarılır', () => {
    const lockup = node({
      type: 'LockupView',
      content_id: 'lockup12345',
      content_type: 'VIDEO',
      metadata: {
        title: { text: 'Yeni arayüz videosu' },
        metadata: {
          metadata_rows: [
            { metadata_parts: [{ text: { text: 'Küçük Kanal' } }] },
            {
              metadata_parts: [{ text: { text: '84K views' } }, { text: { text: '2 days ago' } }],
            },
          ],
        },
      },
      renderer_context: {
        command_context: { on_tap: { browseEndpoint: { browseId: CHANNEL_ID } } },
      },
      content_image: {
        primary_thumbnail: { image: { sources: [{ url: 'https://i.ytimg.com/vi/x/hq.jpg' }] } },
      },
    });

    const card = normalizeNode(lockup);
    expect(card?.videoId).toBe('lockup12345');
    expect(card?.kind).toBe('video');
    expect(card?.channelName).toBe('Küçük Kanal');
    expect(card?.viewsApprox).toBe(84_000);
    expect(card?.publishedAgeDays).toBe(2);
    expect(card?.channelId).toBe(CHANNEL_ID);
    expect(card?.thumbnailUrl).toContain('i.ytimg.com/vi/');
  });

  it('content_type SHORT ise süreye bakılmadan Shorts', () => {
    const card = normalizeNode(
      node({ type: 'LockupView', content_id: 'short123456', content_type: 'SHORT' }),
    );
    expect(card?.kind).toBe('short');
  });

  it('ShortsLockupView düğümü yapısal olarak Shorts', () => {
    const card = normalizeNode(
      node({
        type: 'ShortsLockupView',
        entity_id: 'shortsEntity',
        overlay_metadata: {
          primary_text: { text: 'Kısa' },
          secondary_text: { text: '2.1M views' },
        },
      }),
    );
    expect(card?.kind).toBe('short');
    expect(card?.viewsApprox).toBe(2_100_000);
  });
});

describe('classifyKind', () => {
  const facts = (overrides: Partial<ReturnType<typeof emptyFacts>>) => ({
    ...emptyFacts('Video'),
    ...overrides,
  });

  it('3 dakikalık yatay video ELENMEZ — süre tek başına Shorts kanıtı değil', () => {
    // Shorts sınırı Ekim 2024'te 3 dakikaya çıktı; süreye bakıp elemek binlerce
    // gerçek yatay videoyu kaybettirirdi.
    expect(classifyKind(facts({ durationSec: 170 }))).toBe('video');
    expect(classifyKind(facts({ durationSec: 179 }))).toBe('video');
  });

  it('eski 60 saniyelik sınırın altı güvenle Shorts sayılır', () => {
    expect(classifyKind(facts({ durationSec: 45 }))).toBe('short');
    expect(classifyKind(facts({ durationSec: SAFE_SHORTS_DURATION_SEC }))).toBe('video');
  });

  it('mix, playlist ve film ayrı türlerdir', () => {
    expect(classifyKind(facts({ nodeType: 'Mix' }))).toBe('mix');
    expect(classifyKind(facts({ nodeType: 'CompactPlaylist' }))).toBe('playlist');
    expect(classifyKind(facts({ nodeType: 'Movie' }))).toBe('movie');
  });

  it('tanınmayan düğüm tipi patlamaz, unknown olur', () => {
    expect(classifyKind(facts({ nodeType: 'BrandNewShelfRenderer' }))).toBe('unknown');
  });

  it('yapısal kanıt sezgisel kanıttan önce gelir', () => {
    // Süre 10 dakika ama düğüm tipi Shorts diyor: düğüm tipi kazanır.
    expect(classifyKind(facts({ nodeType: 'ShortsLockupView', durationSec: 600 }))).toBe('short');
  });
});

describe('factsToCard', () => {
  it('video kimliği yoksa kart üretilmez', () => {
    expect(factsToCard(emptyFacts('Video'))).toBeNull();
  });

  it('okunamayan metrikler null kalır, sıfıra çevrilmez', () => {
    const card = factsToCard({
      ...emptyFacts('Video'),
      videoId: 'abc12345678',
      viewsText: 'çöp',
      publishedText: 'LIVE',
    });
    expect(card?.viewsApprox).toBeNull();
    expect(card?.publishedAgeDays).toBeNull();
  });

  it('kaynak düğüm tipi kartta korunur (kırılma teşhisi için)', () => {
    const card = factsToCard({ ...emptyFacts('CompactVideo'), videoId: 'abc12345678' });
    expect(card?.sourceNodeType).toBe('CompactVideo');
  });
});
