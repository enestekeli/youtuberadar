import { OUR_EXCLUDE_TERMS, OUR_SEED_QUERIES } from '@hype/shared';
import { describe, expect, it } from 'vitest';
import { checkTopic, normalizeTopicText, topicDriftLimit } from './topic.js';

describe('konu kapısı', () => {
  it('Türkçe karakterleri normalize edip dahil terimi bulur', () => {
    const result = checkTopic(
      'Elektrikli otomobil batarya incelemesi',
      'Sürüş Günlüğü',
      ['elektrikli otomobil', 'şarj'],
      [],
    );
    expect(result.verdict).toBe('accepted');
    expect(result.matchedTerms).toEqual(['elektrikli otomobil']);
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('hariç terimi dahil eşleşmeden önce uygular', () => {
    const result = checkTopic(
      'Elektrikli otomobil için gece sürüş müziği',
      null,
      ['elektrikli otomobil'],
      ['müzik'],
    );
    expect(result.verdict).toBe('excluded');
    expect(result.excludedTerm).toBe('müzik');
  });

  it('niş kapalıysa konuyu elemez', () => {
    expect(checkTopic('Herhangi bir video', null, [], []).verdict).toBe('accepted');
    expect(checkTopic('Herhangi bir video', null, [], []).score).toBeNull();
  });

  it('katılık modlarını 0/1/3 köprü adımına çevirir', () => {
    expect(topicDriftLimit('strict')).toBe(0);
    expect(topicDriftLimit('balanced')).toBe(1);
    expect(topicDriftLimit('explore')).toBe(3);
  });

  it('normalizasyon noktalama ve aksanı kaldırır', () => {
    expect(normalizeTopicText('ŞARJ & Sürüş!')).toBe('sarj surus');
  });
});

describe('bizim sistem yasak terimleri', () => {
  it('bizim sistem tohumları kendi yasak terimlerine takılmaz', () => {
    for (const list of Object.values(OUR_SEED_QUERIES)) {
      for (const seed of list) {
        expect(checkTopic(seed, null, [], OUR_EXCLUDE_TERMS).verdict, seed).toBe('accepted');
      }
    }
  });

  it('yasak terimler bizim nişlerin başlıklarını elemez', () => {
    // Kök gevşetmesi tuzakları: animation, chemical reaction, Hindenburg, dramatic.
    const temiz = [
      'Every Type of Engine Explained (2D animation)',
      'The Chemical Reaction That Built Rome',
      'The Hindenburg Disaster Explained',
      'The Dramatic Fall of Pompeii',
      'What If the Ocean Disappeared?',
      'Animals of the Deep Sea Iceberg',
    ];
    for (const title of temiz) {
      expect(checkTopic(title, null, [], OUR_EXCLUDE_TERMS).verdict, title).toBe('accepted');
    }
    for (const title of [
      '8 Hours of Rain for Sleep',
      'True Crime Case Explained',
      'Minecraft Gameplay',
    ]) {
      expect(checkTopic(title, null, [], OUR_EXCLUDE_TERMS).verdict, title).toBe('excluded');
    }
  });
});
