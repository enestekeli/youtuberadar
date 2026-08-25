import type { CrawlConfig } from '@hype/shared';

export type TopicVerdict = 'accepted' | 'mismatch' | 'excluded';

export interface TopicCheck {
  verdict: TopicVerdict;
  /** 0..1; konu kapısı kapalıysa null. */
  score: number | null;
  matchedTerms: string[];
  excludedTerm: string | null;
}

const DRIFT_LIMIT: Record<CrawlConfig['topicStrictness'], number> = {
  strict: 0,
  balanced: 1,
  explore: 3,
};

export function topicDriftLimit(strictness: CrawlConfig['topicStrictness']): number {
  return DRIFT_LIMIT[strictness];
}

/**
 * Başlık + kanal adı üzerinde deterministik niş kapısı.
 *
 * İlk sürüm bilinçli olarak yerel ve açıklanabilir: kullanıcı kartta hangi
 * terimin eşleştiğini görür. Çok dilli embedding daha sonra aynı sözleşmenin
 * arkasına eklenebilir; motor ve veri modeli değişmek zorunda kalmaz.
 */
export function checkTopic(
  title: string,
  channelName: string | null,
  includeTerms: readonly string[],
  excludeTerms: readonly string[],
): TopicCheck {
  const haystack = normalizeTopicText(`${title} ${channelName ?? ''}`);

  for (const term of excludeTerms) {
    if (containsTerm(haystack, term)) {
      return {
        verdict: 'excluded',
        score: 0,
        matchedTerms: [],
        excludedTerm: term,
      };
    }
  }

  if (includeTerms.length === 0) {
    return {
      verdict: 'accepted',
      score: null,
      matchedTerms: [],
      excludedTerm: null,
    };
  }

  const matchedTerms = includeTerms.filter((term) => containsTerm(haystack, term));
  if (matchedTerms.length === 0) {
    return {
      verdict: 'mismatch',
      score: 0,
      matchedTerms: [],
      excludedTerm: null,
    };
  }

  // Tek güçlü eşleşme kabul için yeterli; ek eşleşmeler güveni yükseltir.
  const coverage = matchedTerms.length / Math.min(includeTerms.length, 4);
  return {
    verdict: 'accepted',
    score: Math.min(1, 0.5 + coverage * 0.5),
    matchedTerms,
    excludedTerm: null,
  };
}

export function normalizeTopicText(value: string): string {
  return value
    .toLocaleLowerCase('tr')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function containsTerm(haystack: string, rawTerm: string): boolean {
  const term = normalizeTopicText(rawTerm);
  if (term.length === 0) return false;

  // CJK metninde kelime arası boşluk yok; doğrudan alt dize doğru davranış.
  if (!term.includes(' ') && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)) {
    return haystack.includes(term);
  }
  if (` ${haystack} `.includes(` ${term} `)) return true;

  // Türkçe gibi eklemeli dillerde kelimenin son sesi ek alınca değişebilir
  // (müzik -> müziği). Dört karakterden kısa köklerde gevşetme yapılmaz.
  const words = haystack.split(' ');
  return term.split(' ').every((part) => {
    const stem = part.length >= 5 ? part.slice(0, -1) : part;
    return words.some((word) => word.startsWith(stem));
  });
}
