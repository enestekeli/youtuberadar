import { describe, expect, it } from 'vitest';
import {
  looksLikeHiddenSubscribers,
  parseCompactNumber,
  parseDurationText,
  parseJoinedDate,
  parseRelativeAgeDays,
  parseSubscriberCount,
} from './text-parse.js';

describe('parseCompactNumber', () => {
  it('birimli sayıları çözer', () => {
    expect(parseCompactNumber('1.2M views')).toBe(1_200_000);
    expect(parseCompactNumber('12K views')).toBe(12_000);
    expect(parseCompactNumber('1.2B views')).toBe(1_200_000_000);
    expect(parseCompactNumber('999K')).toBe(999_000);
  });

  it('binlik ayraçlı tam sayıları çözer', () => {
    expect(parseCompactNumber('1,234 views')).toBe(1234);
    expect(parseCompactNumber('84,213 views')).toBe(84_213);
    expect(parseCompactNumber('5 views')).toBe(5);
  });

  it('"No views" gerçekten sıfırdır', () => {
    expect(parseCompactNumber('No views')).toBe(0);
  });

  it('okunamayan metin null döner — asla sıfır varsayılmaz', () => {
    expect(parseCompactNumber('views')).toBeNull();
    expect(parseCompactNumber('')).toBeNull();
    expect(parseCompactNumber(null)).toBeNull();
    expect(parseCompactNumber(undefined)).toBeNull();
    expect(parseCompactNumber('LIVE')).toBeNull();
  });

  it('küsuratlı birim doğru yuvarlanır', () => {
    expect(parseCompactNumber('1.25M views')).toBe(1_250_000);
    expect(parseCompactNumber('3.7K views')).toBe(3700);
  });
});

describe('parseRelativeAgeDays', () => {
  it('gün, hafta, ay, yıl', () => {
    expect(parseRelativeAgeDays('3 days ago')).toBe(3);
    expect(parseRelativeAgeDays('2 weeks ago')).toBe(14);
    expect(parseRelativeAgeDays('1 month ago')).toBeCloseTo(30.44, 2);
    expect(parseRelativeAgeDays('2 years ago')).toBeCloseTo(730.5, 1);
  });

  it('gün altı birimler kesire çevrilir', () => {
    expect(parseRelativeAgeDays('12 hours ago')).toBeCloseTo(0.5, 5);
    expect(parseRelativeAgeDays('30 minutes ago')).toBeCloseTo(30 / 1440, 6);
  });

  it('önek taşıyan metinler de çözülür', () => {
    expect(parseRelativeAgeDays('Streamed 5 days ago')).toBe(5);
    expect(parseRelativeAgeDays('Premiered 1 day ago')).toBe(1);
  });

  it('canlı ve okunamayan metinler null', () => {
    expect(parseRelativeAgeDays('LIVE')).toBeNull();
    expect(parseRelativeAgeDays('Premieres tomorrow')).toBeNull();
    expect(parseRelativeAgeDays(null)).toBeNull();
  });
});

describe('parseDurationText', () => {
  it('dakika:saniye ve saat:dakika:saniye', () => {
    expect(parseDurationText('12:34')).toBe(754);
    expect(parseDurationText('0:45')).toBe(45);
    expect(parseDurationText('1:02:03')).toBe(3723);
  });

  it('süre olmayan metin null', () => {
    expect(parseDurationText('LIVE')).toBeNull();
    expect(parseDurationText('12')).toBeNull();
    expect(parseDurationText(null)).toBeNull();
  });
});

describe('abone sayısı', () => {
  it('yuvarlanmış metni çözer', () => {
    expect(parseSubscriberCount('12.3K subscribers')).toBe(12_300);
    expect(parseSubscriberCount('1.2M subscribers')).toBe(1_200_000);
    expect(parseSubscriberCount('842 subscribers')).toBe(842);
  });

  it('gizli abone sayısı bir değer değil, bir bayraktır', () => {
    expect(parseSubscriberCount('Hidden')).toBeNull();
    expect(looksLikeHiddenSubscribers('Hidden')).toBe(true);
    expect(looksLikeHiddenSubscribers('12.3K subscribers')).toBe(false);
  });
});

describe('parseJoinedDate', () => {
  it('kanal kuruluş tarihini epoch ms olarak okur', () => {
    expect(parseJoinedDate('Joined Mar 4, 2024')).toBe(Date.UTC(2024, 2, 4));
    expect(parseJoinedDate('Joined Jan 1, 2020')).toBe(Date.UTC(2020, 0, 1));
    expect(parseJoinedDate('Joined Dec 31, 2015')).toBe(Date.UTC(2015, 11, 31));
  });

  it('SAAT DİLİMİNDEN bağımsız — Date.parse kullanılmıyor', () => {
    /*
     * Bu testin varlık sebebi: `Date.parse('Mar 4, 2024')` yerel saat dilimine
     * göre çözülür, yani makineye göre bir gün kayabilir. Bir günlük kayma
     * "5 ay 29 gün" ile "6 ay 1 gün" arasındaki kararı çevirebilir — yani
     * kanalın moda girip girmemesini belirler.
     */
    expect(parseJoinedDate('Joined Mar 4, 2024')).toBe(1_709_510_400_000);
  });

  it('"Joined" öneki olmadan da okur (savunmacı)', () => {
    expect(parseJoinedDate('Mar 4, 2024')).toBe(Date.UTC(2024, 2, 4));
    expect(parseJoinedDate('Sept. 12, 2021')).toBe(Date.UTC(2021, 8, 12));
  });

  it('okunamayan girdide TAHMİN ETMEZ, null döner', () => {
    expect(parseJoinedDate('Katıldı 4 Mart 2024')).toBeNull();
    expect(parseJoinedDate('Joined recently')).toBeNull();
    expect(parseJoinedDate('')).toBeNull();
    expect(parseJoinedDate(null)).toBeNull();
    expect(parseJoinedDate(undefined)).toBeNull();
  });

  it('anlamsız tarihler reddedilir', () => {
    // YouTube 2005'te kuruldu; öncesi ve uzak gelecek ayrıştırma hatasıdır.
    expect(parseJoinedDate('Joined Mar 4, 1999')).toBeNull();
    expect(parseJoinedDate('Joined Mar 45, 2024')).toBeNull();
  });
});

describe('kısa yaş biçimi (öneri rafı, 2026-11-05)', () => {
  it('"2y ago", "3mo ago", "5d ago" okunur', () => {
    expect(parseRelativeAgeDays('2y ago')).toBeCloseTo(730.5, 1);
    expect(parseRelativeAgeDays('3mo ago')).toBeCloseTo(91.32, 1);
    expect(parseRelativeAgeDays('5d ago')).toBe(5);
    expect(parseRelativeAgeDays('1w ago')).toBe(7);
    expect(parseRelativeAgeDays('4h ago')).toBeCloseTo(4 / 24, 5);
    expect(parseRelativeAgeDays('10min ago')).toBeCloseTo(10 / 1440, 6);
    expect(parseRelativeAgeDays('2 yrs ago')).toBeCloseTo(730.5, 1);
    expect(parseRelativeAgeDays('No views')).toBeNull();
  });

  it('çıplak izlenme sayısı okunur', () => {
    expect(parseCompactNumber('4.7M')).toBe(4_700_000);
    expect(parseCompactNumber('812K')).toBe(812_000);
  });
});
