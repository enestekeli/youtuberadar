import type { RawVideoCard, VideoKind } from '@hype/shared';
import { parseCompactNumber, parseDurationText, parseRelativeAgeDays } from './text-parse.js';

/**
 * Bir feed düğümünden okunabilen ham gerçekler. youtubei.js'e özgü tiplerden
 * arındırılmış olması bilinçli: sınıflandırma mantığının tamamı bu düz nesne
 * üzerinde çalışır ve gerçek bir InnerTube yanıtı olmadan test edilebilir.
 */
export interface NodeFacts {
  nodeType: string;
  videoId: string | null;
  title: string;
  channelId: string | null;
  channelName: string | null;
  durationText: string | null;
  durationSec: number | null;
  viewsText: string | null;
  publishedText: string | null;
  thumbnailUrl: string | null;
  isLive: boolean;
  isUpcoming: boolean;
  /** LockupView.content_type — yeni arayüzün tür bildirimi. */
  contentType: string | null;
}

export function emptyFacts(nodeType: string): NodeFacts {
  return {
    nodeType,
    videoId: null,
    title: '',
    channelId: null,
    channelName: null,
    durationText: null,
    durationSec: null,
    viewsText: null,
    publishedText: null,
    thumbnailUrl: null,
    isLive: false,
    isUpcoming: false,
    contentType: null,
  };
}

/** Doğrudan Shorts anlamına gelen düğüm tipleri. */
const SHORTS_NODE_TYPES = new Set(['ShortsLockupView', 'ReelItem', 'ReelShelf']);

const PLAYLIST_NODE_TYPES = new Set([
  'Playlist',
  'CompactPlaylist',
  'GridPlaylist',
  'PlaylistVideoThumbnail',
]);

const MIX_NODE_TYPES = new Set([
  'Mix',
  'CompactMix',
  'GridMix',
  'CompactStation',
  'AutomixPreviewVideo',
]);

const MOVIE_NODE_TYPES = new Set(['Movie', 'CompactMovie']);

const VIDEO_NODE_TYPES = new Set([
  'Video',
  'GridVideo',
  'CompactVideo',
  'PlaylistVideo',
  'PlaylistPanelVideo',
  'WatchCardCompactVideo',
  'LockupView',
  'RichItem',
]);

/**
 * Shorts elemesinin süreye dayandırılabileceği en güvenli sınır.
 *
 * Shorts üst sınırı Ekim 2024'te 3 dakikaya çıktı; 3 dakikanın altını Shorts
 * saymak binlerce gerçek yatay videoyu kaybettirirdi. Eski 60 saniyelik sınır
 * ise hâlâ güvenli: 61 saniyeden kısa yatay bir video zaten aradığımız türden
 * bir "hit" olamaz.
 */
export const SAFE_SHORTS_DURATION_SEC = 61;

/**
 * Düğümün türünü belirler.
 *
 * Sıralama önemli: yapısal kanıt (düğüm tipi, content_type) her zaman
 * sezgisel kanıttan (süre) önce gelir.
 */
export function classifyKind(facts: NodeFacts): VideoKind {
  if (SHORTS_NODE_TYPES.has(facts.nodeType)) return 'short';

  const contentType = facts.contentType?.toUpperCase() ?? null;
  if (contentType === 'SHORT') return 'short';
  if (contentType === 'PLAYLIST' || contentType === 'SHOPPING_COLLECTION') return 'playlist';
  if (contentType === 'MOVIE') return 'movie';
  if (contentType === 'CHANNEL' || contentType === 'PRODUCT' || contentType === 'GAME') {
    return 'unknown';
  }

  if (MIX_NODE_TYPES.has(facts.nodeType)) return 'mix';
  if (PLAYLIST_NODE_TYPES.has(facts.nodeType)) return 'playlist';
  if (MOVIE_NODE_TYPES.has(facts.nodeType)) return 'movie';

  if (facts.isUpcoming) return 'upcoming';
  if (facts.isLive) return 'live';

  if (!VIDEO_NODE_TYPES.has(facts.nodeType)) return 'unknown';

  // Süre yalnızca eski, güvenli sınırın altında kanıt sayılır.
  if (facts.durationSec !== null && facts.durationSec > 0) {
    if (facts.durationSec < SAFE_SHORTS_DURATION_SEC) return 'short';
  }

  return 'video';
}

/**
 * Ham gerçekleri motorun anladığı karta çevirir.
 *
 * Video kimliği yoksa kart üretilmez (null): kimliksiz bir düğüm ne gezilebilir
 * ne skorlanabilir.
 */
export function factsToCard(facts: NodeFacts): RawVideoCard | null {
  if (facts.videoId === null || facts.videoId.length === 0) return null;

  const durationSec = facts.durationSec ?? parseDurationText(facts.durationText);
  const enriched: NodeFacts = { ...facts, durationSec };

  return {
    videoId: facts.videoId,
    title: facts.title,
    channelId: facts.channelId,
    channelName: facts.channelName,
    kind: classifyKind(enriched),
    durationSec,
    viewsApprox: parseCompactNumber(facts.viewsText),
    publishedAgeDays: parseRelativeAgeDays(facts.publishedText),
    thumbnailUrl: facts.thumbnailUrl,
    sourceNodeType: facts.nodeType,
  };
}
