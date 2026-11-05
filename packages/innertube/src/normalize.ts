import type { RawVideoCard } from '@hype/shared';
import type { Helpers } from 'youtubei.js';
import { YTNodes } from 'youtubei.js';
import { emptyFacts, factsToCard, type NodeFacts } from './node-facts.js';
import { parseDurationText } from './text-parse.js';

type YTNode = Helpers.YTNode;

/**
 * Kütüphanenin sınıf adlarına derleme zamanı bağı.
 *
 * Alan okumaları bilinçli olarak yapısal (defansif optional chaining): YouTube
 * A/B testleriyle düğüm şekillerini habersiz değiştiriyor ve tip iddiası
 * (`.as()`) böyle bir ortamda çalışma zamanında patlıyor. Ama sınıf ADLARINI
 * buradan alarak, kütüphane bir sınıfı yeniden adlandırdığında derlemenin
 * kırılmasını garanti ediyoruz — sessizce yanlış sınıflandırmak yerine.
 */
const TYPE = {
  video: YTNodes.Video.type,
  gridVideo: YTNodes.GridVideo.type,
  compactVideo: YTNodes.CompactVideo.type,
  playlistVideo: YTNodes.PlaylistVideo.type,
  lockupView: YTNodes.LockupView.type,
  shortsLockupView: YTNodes.ShortsLockupView.type,
  reelItem: YTNodes.ReelItem.type,
  richItem: YTNodes.RichItem.type,
} as const;

interface TextLike {
  text?: string;
}

interface ThumbnailLike {
  url?: string;
  width?: number;
}

/** Düğümlerin ortak alanları — hiçbiri garanti değil, hepsi opsiyonel okunur. */
interface VideoLike {
  video_id?: string;
  content_id?: string;
  title?: TextLike;
  author?: { id?: string; name?: string };
  view_count?: TextLike;
  short_view_count?: TextLike;
  published?: TextLike;
  length_text?: TextLike;
  thumbnails?: ThumbnailLike[];
  thumbnail?: ThumbnailLike[];
  duration?: { seconds?: number };
  is_live?: boolean;
  is_upcoming?: boolean;
  upcoming?: unknown;
  content_type?: string;
  metadata?: unknown;
  overlay_metadata?: { primary_text?: TextLike; secondary_text?: TextLike };
  entity_id?: string;
  content?: unknown;
  content_image?: { image?: ThumbnailLike[]; overlays?: unknown[] };
}

function textOf(value: TextLike | null | undefined): string | null {
  const text = value?.text;
  return typeof text === 'string' && text.trim().length > 0 ? text : null;
}

function bestThumbnail(thumbnails: ThumbnailLike[] | undefined): string | null {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  let best: ThumbnailLike | null = null;
  for (const candidate of thumbnails) {
    if (typeof candidate?.url !== 'string') continue;
    if (best === null || (candidate.width ?? 0) > (best.width ?? 0)) best = candidate;
  }
  return best?.url ?? null;
}

/**
 * Derinlik sınırlı arama ile bir kimlik bulur.
 *
 * Yeni `LockupView` ailesi kanal kimliğini sabit bir alanda taşımıyor; her
 * arayüz sürümünde farklı bir alt nesnede duruyor. Şemaya sıkı bağlanmak
 * yerine, aranan biçime uyan ilk değeri buluyoruz. Kimlik bulunamazsa null
 * döner ve kart Kapı 0'da elenir — uydurma yapılmaz.
 */
function findId(
  root: unknown,
  keys: readonly string[],
  pattern: RegExp,
  maxDepth = 6,
): string | null {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  const seen = new Set<unknown>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const { node, depth } = current;
    if (node === null || typeof node !== 'object' || depth > maxDepth) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && keys.includes(key) && pattern.test(value)) return value;
      if (value !== null && typeof value === 'object')
        stack.push({ node: value, depth: depth + 1 });
    }
  }
  return null;
}

const VIDEO_ID_KEYS = ['videoId', 'video_id', 'contentId', 'content_id'] as const;
const CHANNEL_ID_KEYS = ['browseId', 'browse_id', 'channelId', 'channel_id', 'id'] as const;
const VIDEO_ID_PATTERN = /^[\w-]{8,20}$/;
const CHANNEL_ID_PATTERN = /^UC[\w-]{20,24}$/;

const DURATION_BADGE_PATTERN = /^\d{1,2}(:\d{2}){1,2}$/;

/**
 * Kapak resmi üzerindeki rozetler: süre ("58:06") ve canlı işareti.
 * `ThumbnailView.overlays[].badges[].text` yolunda duruyor.
 */
function readOverlayBadges(overlays: unknown): { durationText: string | null; isLive: boolean } {
  let durationText: string | null = null;
  let isLive = false;
  if (!Array.isArray(overlays)) return { durationText, isLive };

  for (const overlay of overlays) {
    const badges = (overlay as { badges?: unknown[] } | null)?.badges;
    if (!Array.isArray(badges)) continue;
    for (const badge of badges) {
      const text = (badge as { text?: unknown } | null)?.text;
      if (typeof text !== 'string') continue;
      if (durationText === null && DURATION_BADGE_PATTERN.test(text.trim())) {
        durationText = text.trim();
      }
      if (/^live$/i.test(text.trim())) isLive = true;
    }
  }
  return { durationText, isLive };
}

/** ContentMetadataView satırlarındaki düz metinler, satır satır. */
function collectMetadataRows(metadata: unknown): string[][] {
  const out: string[][] = [];
  const rows = (metadata as { metadata_rows?: unknown[] } | null)?.metadata_rows;
  if (!Array.isArray(rows)) return out;

  for (const row of rows) {
    const parts = (row as { metadata_parts?: unknown[] } | null)?.metadata_parts;
    if (!Array.isArray(parts)) continue;
    const texts: string[] = [];
    for (const part of parts) {
      const text = textOf((part as { text?: TextLike } | null)?.text);
      if (text !== null) texts.push(text);
    }
    if (texts.length > 0) out.push(texts);
  }
  return out;
}

/*
 * İzlenme metni mi? Eski biçim "84K views"; 2026-11-05'ten beri öneri rafı
 * yalnız "4.7M" yazıyor (kelime yok). Çıplak sayı yalnız kanal satırı dışında
 * aranır — "1917" adlı bir kanal izlenme sanılmasın.
 */
const VIEWS_WORD = /\bviews?\b/i;
const BARE_COUNT = /^\s*\d[\d.,]*\s*[kmb]?\s*$/i;
const AGE_TEXT = /\bago\s*$/i;
const LIVE_TEXT = /\bwatching\b/i;

/** youtubei.js düğümünden ham gerçekleri okur. */
export function readFacts(node: YTNode): NodeFacts {
  const raw = node as unknown as VideoLike;
  const facts = emptyFacts(node.type);

  // RichItem yalnızca bir sarmalayıcı: içindeki gerçek düğüme in.
  if (node.type === TYPE.richItem) {
    const inner = raw.content;
    if (inner !== null && typeof inner === 'object' && 'type' in inner) {
      return readFacts(inner as YTNode);
    }
  }

  if (node.type === TYPE.shortsLockupView || node.type === TYPE.reelItem) {
    facts.videoId = raw.entity_id ?? findId(node, VIDEO_ID_KEYS, VIDEO_ID_PATTERN);
    facts.title = textOf(raw.overlay_metadata?.primary_text) ?? textOf(raw.title) ?? '';
    facts.viewsText = textOf(raw.overlay_metadata?.secondary_text) ?? textOf(raw.view_count);
    facts.thumbnailUrl = bestThumbnail(raw.thumbnail ?? raw.thumbnails);
    return facts;
  }

  if (node.type === TYPE.lockupView) {
    const metadataView = (raw.metadata as { title?: TextLike; metadata?: unknown } | null) ?? null;
    facts.videoId = raw.content_id ?? findId(node, VIDEO_ID_KEYS, VIDEO_ID_PATTERN);
    facts.title = textOf(metadataView?.title) ?? '';
    facts.contentType = raw.content_type ?? null;
    facts.channelId = findId(node, CHANNEL_ID_KEYS, CHANNEL_ID_PATTERN);

    // Süre ve canlı rozeti metadata satırlarında değil, kapak resminin
    // üzerindeki rozetlerde duruyor. Kapak da doğrudan burada — sezgisel URL
    // aramasına gerek yok.
    const contentImage = raw.content_image as
      | { image?: ThumbnailLike[]; overlays?: unknown[] }
      | null
      | undefined;
    facts.thumbnailUrl = bestThumbnail(contentImage?.image) ?? findThumbnailUrl(node);
    const badges = readOverlayBadges(contentImage?.overlays);
    facts.durationText = badges.durationText;
    facts.durationSec = parseDurationText(badges.durationText);

    const rows = collectMetadataRows(metadataView?.metadata);
    const texts = rows.flat();
    const isStat = (t: string) => VIEWS_WORD.test(t) || AGE_TEXT.test(t) || LIVE_TEXT.test(t);
    // Kanal adı ilk satırda; birden çok satır varsa istatistikler sonrakilerde.
    const statTexts = rows.length > 1 ? rows.slice(1).flat() : texts;
    facts.channelName =
      (rows.length > 1 ? rows[0]?.find((t) => !isStat(t)) : undefined) ??
      texts.find((t) => !isStat(t) && !BARE_COUNT.test(t)) ??
      null;
    facts.viewsText =
      statTexts.find((t) => VIEWS_WORD.test(t)) ??
      statTexts.find((t) => BARE_COUNT.test(t) && t !== facts.channelName) ??
      null;
    facts.publishedText = statTexts.find((t) => AGE_TEXT.test(t)) ?? null;
    facts.isLive = badges.isLive || texts.some((t) => /watching now/i.test(t));
    return facts;
  }

  // Video / GridVideo / CompactVideo / PlaylistVideo ve akrabaları aynı alanları
  // paylaşır; birini destekleyen okuma hepsini destekler.
  facts.videoId = raw.video_id ?? findId(node, VIDEO_ID_KEYS, VIDEO_ID_PATTERN);
  facts.title = textOf(raw.title) ?? '';
  facts.channelId =
    normalizeChannelId(raw.author?.id) ?? findId(node, CHANNEL_ID_KEYS, CHANNEL_ID_PATTERN);
  facts.channelName = raw.author?.name ?? null;
  facts.viewsText = textOf(raw.view_count) ?? textOf(raw.short_view_count);
  facts.publishedText = textOf(raw.published);
  facts.durationText = textOf(raw.length_text);
  facts.durationSec = readDurationSeconds(raw);
  facts.thumbnailUrl = bestThumbnail(raw.thumbnails);
  facts.isLive = raw.is_live === true;
  facts.isUpcoming = raw.is_upcoming === true || raw.upcoming !== undefined;
  return facts;
}

function normalizeChannelId(id: string | undefined): string | null {
  return typeof id === 'string' && CHANNEL_ID_PATTERN.test(id) ? id : null;
}

function readDurationSeconds(raw: VideoLike): number | null {
  const seconds = raw.duration?.seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) return seconds;
  return parseDurationText(textOf(raw.length_text));
}

/** Video kapağı kanal avatarıyla karışmasın diye önce ytimg video yolu aranır. */
function findThumbnailUrl(node: unknown): string | null {
  const video = findId(node, ['url'], /^https?:\/\/i\.ytimg\.com\/vi\//, 8);
  return video ?? findId(node, ['url'], /^https?:\/\/\S+$/, 8);
}

/** Feed düğümünü motorun kartına çevirir. Kimliksiz düğüm için null. */
export function normalizeNode(node: YTNode): RawVideoCard | null {
  return factsToCard(readFacts(node));
}

export function normalizeNodes(nodes: readonly YTNode[] | null | undefined): RawVideoCard[] {
  if (!Array.isArray(nodes)) return [];
  const cards: RawVideoCard[] = [];
  for (const node of nodes) {
    const card = normalizeNode(node);
    if (card !== null) cards.push(card);
  }
  return cards;
}

export { TYPE as NODE_TYPE_NAMES };
