import {
  type LowConfidenceReason,
  LowConfidenceReasonSchema,
  type Match,
  MatchSchema,
  type PoolItem,
  type ScoreType,
  type VideosQuery,
} from '@hype/shared';
import { and, asc, desc, eq, gte, like, lte, ne, or, type SQL } from 'drizzle-orm';
import type { Db } from '../client.js';
import { videos } from '../schema.js';

export type VideoStatus = 'pooled' | 'discarded' | 'exported';

export interface EnrichmentPatch {
  description?: string | null;
  publishedAt?: string | null;
  likes?: number | null;
  suspectedBoughtTraffic?: boolean;
}

export interface VideoPage {
  items: PoolItem[];
  nextCursor: string | null;
}

type VideoRow = typeof videos.$inferSelect;

/**
 * Havuz deposu.
 *
 * Kayıt sırasında `MatchSchema` ile doğrulama yapılır: bu bir formalite değil,
 * bütünlük bekçisi. InnerTube sessizce kısıtladığında izlenme sayısı tanımsız
 * gelir; böyle bir kaydın veritabanına girmesi, kullanıcıya yanlış bir çarpan
 * göstermek demektir. Şema düzeyinde reddediliyor.
 */
export class SqliteVideoRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  saveMatch(match: Match): void {
    const validated = MatchSchema.parse(match);
    const now = this.now();

    this.db
      .insert(videos)
      .values({
        videoId: validated.videoId,
        runId: validated.runId,
        channelId: validated.channelId,
        title: validated.title,
        thumbnailUrl: validated.thumbnailUrl,
        durationSec: Math.round(validated.durationSec),
        views: Math.round(validated.views),
        vpd: validated.vpd,
        projectedViews: validated.projectedViews,
        publishedAgeDays: validated.publishedAgeDays,
        scoreType: validated.scoreType,
        hype: validated.hype,
        vsr: validated.vsr,
        z: validated.z,
        baselineMedian: validated.baselineMedian,
        baselineN: validated.baselineN,
        lowConfidence: validated.lowConfidence,
        lowConfidenceReasonsJson: JSON.stringify(validated.lowConfidenceReasons),
        channelHitRate: validated.channelHitRate,
        channelAgeDays: validated.channelAgeDays,
        channelIsHot: validated.channelIsHot,
        suspectedBoughtTraffic: validated.suspectedBoughtTraffic,
        channelName: validated.channelName,
        subsApprox: validated.subsApprox,
        subsText: validated.subsText,
        subsHidden: validated.subsHidden,
        depth: validated.depth,
        seedVideoId: validated.seedVideoId,
        status: 'pooled',
        statusChangedAt: now,
        caughtAt: validated.caughtAt,
      })
      // Aynı video ikinci kez yakalanırsa (farklı tarama, tazelenmiş sayılar)
      // skoru güncelleriz ama kullanıcının verdiği kararı (çöp/export) EZMEYİZ.
      .onConflictDoUpdate({
        target: videos.videoId,
        set: {
          views: Math.round(validated.views),
          vpd: validated.vpd,
          projectedViews: validated.projectedViews,
          hype: validated.hype,
          vsr: validated.vsr,
          z: validated.z,
          baselineMedian: validated.baselineMedian,
          baselineN: validated.baselineN,
          lowConfidence: validated.lowConfidence,
          lowConfidenceReasonsJson: JSON.stringify(validated.lowConfidenceReasons),
          channelHitRate: validated.channelHitRate,
          channelAgeDays: validated.channelAgeDays,
          refreshedAt: now,
        },
      })
      .run();
  }

  saveBaselineSamples(videoId: string, samples: readonly number[]): void {
    this.db
      .update(videos)
      .set({ baselineSamplesJson: JSON.stringify(samples) })
      .where(eq(videos.videoId, videoId))
      .run();
  }

  get(videoId: string): PoolItem | null {
    const row = this.db.select().from(videos).where(eq(videos.videoId, videoId)).get();
    return row === undefined ? null : toPoolItem(row);
  }

  getRow(videoId: string): VideoRow | null {
    return this.db.select().from(videos).where(eq(videos.videoId, videoId)).get() ?? null;
  }

  setStatus(videoId: string, status: VideoStatus): void {
    this.db
      .update(videos)
      .set({ status, statusChangedAt: this.now() })
      .where(eq(videos.videoId, videoId))
      .run();
  }

  enrich(videoId: string, patch: EnrichmentPatch): void {
    this.db
      .update(videos)
      .set({ ...patch, refreshedAt: this.now() })
      .where(eq(videos.videoId, videoId))
      .run();
  }

  /**
   * Havuz sorgusu.
   *
   * Filtreleme SQL'de yapılıyor: tarama 3 kat eşiğiyle kaydettiği için
   * kullanıcı eşiği sonradan düşürdüğünde yeni tarama gerekmiyor, veri zaten
   * orada. Sayfalama offset tabanlı — yerel araçta havuz birkaç bin satır,
   * keyset karmaşıklığı kazanç getirmiyor.
   */
  list(query: VideosQuery): VideoPage {
    const conditions: SQL[] = [];

    if (query.status !== 'all') conditions.push(eq(videos.status, query.status));
    if (query.runId !== undefined) conditions.push(eq(videos.runId, query.runId));
    if (query.scoreType !== 'all') conditions.push(eq(videos.scoreType, query.scoreType));
    if (query.minViews !== undefined) conditions.push(gte(videos.views, query.minViews));
    if (query.maxAgeDays !== undefined) {
      conditions.push(lte(videos.publishedAgeDays, query.maxAgeDays));
    }
    if (query.goldStarOnly) conditions.push(eq(videos.channelIsHot, true));
    if (query.hideLowConfidence) conditions.push(eq(videos.lowConfidence, false));
    if (query.q !== undefined && query.q.length > 0) {
      conditions.push(like(videos.title, `%${query.q}%`));
    }
    if (query.minHype !== undefined) {
      // İki metrik ayrı kolonlarda; eşik hangisi geçerliyse ona uygulanır.
      const threshold = or(gte(videos.hype, query.minHype), gte(videos.vsr, query.minHype));
      if (threshold !== undefined) conditions.push(threshold);
    }

    const offset = decodeCursor(query.cursor);
    const rows = this.db
      .select()
      .from(videos)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(...orderFor(query.sort))
      .limit(query.limit + 1)
      .offset(offset)
      .all();

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: page.map(toPoolItem),
      nextCursor: hasMore ? encodeCursor(offset + query.limit) : null,
    };
  }

  /**
   * WS anlık görüntüsünün taşıdığı havuz.
   *
   * Taramadan bağımsız: kullanıcının havuzu oturumlar arası birikir, yeni bir
   * tarama başlatmak önceki yakalamaları görünmez yapmaz.
   */
  listRecentPool(limit = 300): PoolItem[] {
    return this.db
      .select()
      .from(videos)
      .where(ne(videos.status, 'discarded'))
      .orderBy(desc(videos.caughtAt))
      .limit(limit)
      .all()
      .map(toPoolItem);
  }

  /** Tek bir taramanın yakaladıkları. */
  listRunPool(runId: string, limit = 500): PoolItem[] {
    return this.db
      .select()
      .from(videos)
      .where(and(eq(videos.runId, runId), ne(videos.status, 'discarded')))
      .orderBy(desc(videos.caughtAt))
      .limit(limit)
      .all()
      .map(toPoolItem);
  }
}

function orderFor(sort: VideosQuery['sort']): SQL[] {
  switch (sort) {
    case 'z':
      return [desc(videos.z), desc(videos.hype)];
    case 'views':
      return [desc(videos.views)];
    case 'vpd':
      return [desc(videos.vpd)];
    case 'date':
      return [desc(videos.caughtAt)];
    case 'subs':
      return [asc(videos.subsApprox)];
    default:
      // Varsayılan: çarpan, eşitlikte z-skoru bozar.
      return [desc(videos.hype), desc(videos.vsr), desc(videos.z)];
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function toPoolItem(row: VideoRow): PoolItem {
  return {
    videoId: row.videoId,
    runId: row.runId,
    title: row.title,
    thumbnailUrl: row.thumbnailUrl,
    durationSec: row.durationSec,
    channelId: row.channelId,
    channelName: row.channelName,
    subsText: row.subsText,
    subsApprox: row.subsApprox,
    views: row.views,
    ageDays: row.publishedAgeDays,
    vpd: row.vpd,
    score: toScore(row),
    receipts:
      row.baselineMedian !== null && row.baselineN !== null
        ? {
            baselineN: row.baselineN,
            baselineMedian: row.baselineMedian,
            baselineSamples: parseSamples(row.baselineSamplesJson),
          }
        : null,
    channelIsHot: row.channelIsHot,
    suspectedBoughtTraffic: row.suspectedBoughtTraffic,
    discarded: row.status === 'discarded',
    depth: row.depth,
    caughtAt: row.caughtAt,
  };
}

function toScore(row: VideoRow): PoolItem['score'] {
  const scoreType = row.scoreType as ScoreType;
  const lowConfidenceReasons = parseReasons(row.lowConfidenceReasonsJson);
  if (scoreType === 'hype' && row.hype !== null) {
    return {
      type: 'hype',
      value: row.hype,
      z: row.z,
      lowConfidence: row.lowConfidence,
      lowConfidenceReasons,
    };
  }
  /*
   * Kanal satırı `vsr` kolonunu paylaşıyor (bkz. schema.ts yorumu), ayrımı
   * `score_type` yapıyor — bu yüzden `vsr` dalından ÖNCE kontrol ediliyor.
   */
  if (scoreType === 'channel' && row.vsr !== null) {
    return {
      type: 'channel',
      value: row.vsr,
      hitRate: row.channelHitRate ?? 0,
      channelAgeDays: row.channelAgeDays,
      uploads: row.baselineN ?? 0,
      lowConfidence: row.lowConfidence,
      lowConfidenceReasons,
    };
  }
  if (row.vsr !== null) {
    return {
      type: 'vsr',
      value: row.vsr,
      lowConfidence: row.lowConfidence,
      lowConfidenceReasons,
    };
  }
  return { type: 'pending' };
}

/**
 * Sebep listesini okur. Sütun eklenmeden önce yakalanmış satırlarda null olur:
 * o kayıtlar "düşük güven" bayrağını taşır ama sebebini bilmiyoruz — uydurmak
 * yerine boş dönüyoruz, arayüz de genel açıklamaya düşüyor.
 */
function parseReasons(json: string | null): LowConfidenceReason[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is LowConfidenceReason => LowConfidenceReasonSchema.safeParse(v).success,
    );
  } catch {
    return [];
  }
}

function parseSamples(json: string | null): number[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => Number.isFinite(v)) : [];
  } catch {
    return [];
  }
}
