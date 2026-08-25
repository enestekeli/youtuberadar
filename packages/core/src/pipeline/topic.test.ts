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
