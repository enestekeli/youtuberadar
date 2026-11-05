import { describe, expect, it } from 'vitest';
import {
  LONG_VIDEO_SEC,
  OUR_MAX_CHANNEL_AGE_DAYS,
  OUR_MIN_MEDIAN_VIEWS,
  OUR_SEED_QUERIES,
} from './bizim-sistem.js';
import {
  BUILTIN_PRESETS,
  CHANNEL_RADAR_DEFAULT_CONFIG,
  CrawlConfigSchema,
  DEFAULT_CRAWL_CONFIG,
  ourSystemConfig,
} from './config.js';

describe('CrawlConfigSchema', () => {
  it('boş girdiden araştırma varsayılanlarını üretir', () => {
    const c = CrawlConfigSchema.parse({});
    expect(c.maxDepth).toBe(4);
    expect(c.maxVideosScanned).toBe(1000);
    expect(c.channelRequestBudget).toBe(300);
    expect(c.requestBudget).toBe(1500);
    expect(c.minSubs).toBe(1000);
    expect(c.maxSubs).toBe(50_000);
    expect(c.hypeThreshold).toBe(5.0);
    expect(c.crawlThreshold).toBe(3.0);
    expect(c.maxVideoAgeDays).toBe(30);
    expect(c.minVideoAgeHours).toBe(18);
    expect(c.minViews).toBe(10_000);
    expect(c.minVpd).toBe(500);
    expect(c.epsilon).toBe(0.2);
    expect(c.baselineSize).toBe(12);
    expect(c.baselineFloor).toBe(400);
  });

  it('minSubs >= maxSubs reddedilir', () => {
    expect(CrawlConfigSchema.safeParse({ minSubs: 50_000, maxSubs: 50_000 }).success).toBe(false);
    expect(CrawlConfigSchema.safeParse({ minSubs: 60_000, maxSubs: 50_000 }).success).toBe(false);
  });

  it('paceMinMs > paceMaxMs reddedilir', () => {
    expect(CrawlConfigSchema.safeParse({ paceMinMs: 5000, paceMaxMs: 2000 }).success).toBe(false);
  });

  it('crawlThreshold > hypeThreshold reddedilir (kayıt eşiği görüntülemeden gevşek olmalı)', () => {
    expect(CrawlConfigSchema.safeParse({ crawlThreshold: 6, hypeThreshold: 5 }).success).toBe(
      false,
    );
  });

  it('minVideoAgeHours yaş penceresinin dışına taşamaz', () => {
    expect(CrawlConfigSchema.safeParse({ minVideoAgeHours: 48, maxVideoAgeDays: 1 }).success).toBe(
      false,
    );
  });

  it('aralık dışı değerler reddedilir', () => {
    expect(CrawlConfigSchema.safeParse({ maxDepth: 1 }).success).toBe(false);
    // Üst sınır 8 → 10 yükseldi: dil filtresiyle birlikte derin zincirler
    // yankı fanusu riski değil, ARANAN şey. 9 artık geçerli, 11 değil.
    expect(CrawlConfigSchema.safeParse({ maxDepth: 9 }).success).toBe(true);
    expect(CrawlConfigSchema.safeParse({ maxDepth: 11 }).success).toBe(false);
    expect(CrawlConfigSchema.safeParse({ epsilon: 1.5 }).success).toBe(false);
  });

  it('tohum boşken varsayılanlar YÜRÜYÜŞ DİLİNDE gelir', () => {
    /*
     * Kullanıcının yakaladığı boşluk: tohum alanı boş bırakılınca sabit
     * İngilizce liste kullanılıyordu, yani Türkçe filtreyle başlatılan bir
     * tarama daha İLK videoda filtrenin dışından başlıyordu.
     */
    const tr = CrawlConfigSchema.parse({ crawlLanguages: ['tr'] });
    expect(tr.seedQueries).toContain('belgesel');
    expect(tr.seedQueries).not.toContain('documentary');

    const de = CrawlConfigSchema.parse({ crawlLanguages: ['de'] });
    expect(de.seedQueries).toContain('dokumentation');
  });

  it('dil verilmemişse bölgenin dili kullanılır', () => {
    const fromRegion = CrawlConfigSchema.parse({ region: 'TR' });
    expect(fromRegion.seedQueries).toContain('belgesel');
  });

  it('ne dil ne bölge varsa İngilizceye düşer — uydurma yapılmaz', () => {
    expect(CrawlConfigSchema.parse({}).seedQueries).toContain('documentary');
    // Desteklenmeyen bir dil de İngilizceye düşer, boş liste üretmez.
    const unknown = CrawlConfigSchema.parse({ crawlLanguages: ['xx'] });
    expect(unknown.seedQueries.length).toBeGreaterThan(0);
  });

  it('kullanıcının yazdığı tohumlar EZİLMEZ', () => {
    const explicit = CrawlConfigSchema.parse({
      crawlLanguages: ['tr'],
      seedQueries: ['kendi terimim'],
    });
    expect(explicit.seedQueries).toEqual(['kendi terimim']);
    expect(explicit.topicIncludeTerms).toEqual(['kendi terimim']);
  });

  it('açık hedef terimler tohumlarla ezilmez, varsayılan tarama konu kapısını açmaz', () => {
    const explicit = CrawlConfigSchema.parse({
      seedQueries: ['elektrikli araç'],
      topicIncludeTerms: ['batarya'],
    });
    expect(explicit.topicIncludeTerms).toEqual(['batarya']);
    expect(CrawlConfigSchema.parse({}).topicIncludeTerms).toEqual([]);
  });

  it('geniş varsayılanlar müzik sorgusu taşımaz', () => {
    for (const language of ['en', 'tr', 'de']) {
      const config = CrawlConfigSchema.parse({ crawlLanguages: [language] });
      expect(config.seedQueries.join(' ').toLocaleLowerCase('tr')).not.toMatch(/music|müzik|musik/);
    }
  });

  it('mod varsayılanı video — eski config JSON’ları bozulmaz', () => {
    /*
     * `mode` alanı eklenmeden önce yazılmış `runs.config_json` kayıtları ve
     * kullanıcının kaydettiği presetler alansız duruyor; hepsi eski davranışta
     * kalmalı.
     */
    const eski = CrawlConfigSchema.parse({ minSubs: 2000 });
    expect(eski.mode).toBe('video');
    expect(eski.maxChannelAgeDays).toBe(180);
    expect(eski.minChannelMedianViews).toBe(10_000);
    expect(eski.minChannelUploads).toBe(4);
    expect(eski.allowUnknownChannelAge).toBe(false);
  });

  it('kanal modu seçilebilir ve eşikleri doğrulanır', () => {
    expect(CrawlConfigSchema.parse({ mode: 'channel' }).mode).toBe('channel');
    expect(CrawlConfigSchema.parse({ minChannelMedianViews: 250_000 }).minChannelMedianViews).toBe(
      250_000,
    );
    expect(CrawlConfigSchema.safeParse({ minChannelMedianViews: -1 }).success).toBe(false);
    expect(CrawlConfigSchema.safeParse({ maxChannelAgeDays: 3 }).success).toBe(false);
    expect(CrawlConfigSchema.safeParse({ mode: 'kanal' }).success).toBe(false);
  });

  it('yerleşik presetlerin hepsi geçerli config üretir', () => {
    for (const preset of BUILTIN_PRESETS) {
      const parsed = CrawlConfigSchema.safeParse(preset.config);
      expect(parsed.success, `preset geçersiz: ${preset.name}`).toBe(true);
    }
  });

  it('DEFAULT_CRAWL_CONFIG şemadan yeniden geçer (idempotent)', () => {
    expect(CrawlConfigSchema.parse(DEFAULT_CRAWL_CONFIG)).toEqual(DEFAULT_CRAWL_CONFIG);
  });

  it('ürün varsayılanı bizim sistem kanal avıdır', () => {
    const c = CHANNEL_RADAR_DEFAULT_CONFIG;
    expect(c.mode).toBe('channel');
    expect(c.maxDepth).toBe(2);
    expect(c.maxChannelAgeDays).toBe(OUR_MAX_CHANNEL_AGE_DAYS);
    expect(c.minChannelMedianViews).toBe(OUR_MIN_MEDIAN_VIEWS);
    expect(c.minLongVideoSec).toBe(LONG_VIDEO_SEC);
    expect(c.minSubs).toBeNull();
    expect(c.maxSubs).toBeNull();
    expect(c.crawlLanguages).toEqual(['en']);
    for (const term of ['müzik', 'vlog', 'sleep', 'true crime', 'gameplay']) {
      expect(c.topicExcludeTerms).toContain(term);
    }
    expect(c.seedQueries).toEqual([...(OUR_SEED_QUERIES.en ?? [])]);
    expect(CrawlConfigSchema.parse(c)).toEqual(c);
  });

  it('bizim sistem ES/DE kendi dilinin tohumlarını alır', () => {
    const es = CrawlConfigSchema.parse(ourSystemConfig('es'));
    expect(es.seedQueries).toEqual([...(OUR_SEED_QUERIES.es ?? [])]);
    expect(es.region).toBe('MX');
    const de = CrawlConfigSchema.parse(ourSystemConfig('de'));
    expect(de.seedQueries).toEqual([...(OUR_SEED_QUERIES.de ?? [])]);
  });

  it('kanal modu dile uygun faceless format tohumları üretir', () => {
    const tr = CrawlConfigSchema.parse({ mode: 'channel', crawlLanguages: ['tr'] });
    expect(tr.seedQueries).toContain('tarih anlatımı');
    expect(tr.seedQueries).not.toContain('gezi vlog');
  });
});
