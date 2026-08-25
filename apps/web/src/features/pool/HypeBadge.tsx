import type { LowConfidenceReason, PoolScore } from '@hype/shared';
import { cx } from '../../components/ui.js';
import { multiplier } from '../../lib/format.js';

/**
 * Sebep metinleri.
 *
 * Tek bir "düşük güven" cümlesi işe yaramıyordu: canlı veride sonuçların
 * %66'sında yanıyor ve bu kadar sık yanan bir uyarı hiçbir şeyi ayırt etmiyordu.
 * Kullanıcı "taban 6 videodan kuruldu" ile "video daha 1 günlük"ü ayırabilmeli.
 */
const REASON_TEXT: Record<LowConfidenceReason, string> = {
  thin_baseline: 'taban çizgisi az sayıda videodan kuruldu',
  tiny_baseline: 'kanalın normali çok düşük, küçük sayılar büyük çarpan üretir',
  young_video: 'video henüz çok genç, izlenmesi oturmadı',
  baseline_floored: 'taban alt sınıra yükseltildi, gerçek medyan daha da düşüktü',
  newer_uploads_only: 'kanal sık yüklüyor, taban adaydan sonraki videolardan kuruldu',
  no_baseline: 'kanal geçmişi yok, skor abone oranından türetildi',
  few_uploads: 'kanalın istikrarı az sayıda videodan okundu',
  subs_hidden: 'kanal abone sayısını gizliyor, "izlenme > abone" ölçülemedi',
  age_unknown: 'kanalın kuruluş tarihi okunamadı',
};

/**
 * Rozetin üstünde gösterilecek açıklama.
 *
 * `skip` ile verilen sebep zaten rozetin kendi metninde yazıyorsa tekrar
 * edilmez — VSR rozeti "kanal geçmişi yetersiz" diyorken altına aynı cümleyi
 * bir daha yazmak açıklamayı gürültüye çevirir.
 */
function confidenceTitle(score: PoolScore, skip?: LowConfidenceReason): string | undefined {
  if (score.type === 'pending' || !score.lowConfidence) return undefined;
  const reasons = score.lowConfidenceReasons.filter((r) => r !== skip).map((r) => REASON_TEXT[r]);
  if (reasons.length === 0) {
    // Sütun eklenmeden önce yakalanmış kayıtlarda sebep yok — uydurmuyoruz.
    return score.lowConfidenceReasons.length === 0
      ? 'Düşük güven: sebebi kaydedilmemiş (eski kayıt)'
      : undefined;
  }
  return `Düşük güven — ${reasons.join(' · ')}`;
}

/**
 * Çarpan rozeti.
 *
 * Kesme noktaları sektör standardı (10x+ / 5–10x / 2–5x) — kullanıcı başka
 * araçlarda gördüğü renk kodunu burada da tanısın diye.
 *
 * VSR rozeti KASITLI olarak farklı: dolu değil çerçeveli, mavi, ve üzerinde
 * "VSR" yazıyor. İki metrik aynı görünürse kullanıcı bir kanalın medyan
 * çarpanıyla başka birinin abone oranını kıyaslar — bu yalan olur.
 */
export function HypeBadge({ score }: { score: PoolScore }) {
  if (score.type === 'pending') {
    return (
      <span className="shimmer inline-flex h-6 w-16 items-center justify-center rounded-full text-[10px] text-muted">
        skorlanıyor
      </span>
    );
  }

  if (score.type === 'vsr') {
    return (
      <span
        title={[
          'Kanal geçmişi yetersiz — abone başına izlenme oranı. Medyan çarpanıyla kıyaslanamaz.',
          // 'no_baseline' bu cümlenin ta kendisi; ikinci kez yazdırmıyoruz.
          confidenceTitle(score, 'no_baseline'),
        ]
          .filter(Boolean)
          .join('\n')}
        className={cx(
          'tnum inline-flex items-center gap-1 rounded-full border border-info px-2 py-0.5 font-semibold text-[11px] text-info',
          score.lowConfidence && 'opacity-60',
        )}
      >
        {multiplier(score.value)} VSR
      </span>
    );
  }

  /*
   * Kanal rozeti de KASITLI olarak farklı görünüyor ve üzerinde yaş + isabet
   * oranı yazıyor. Bulunan şey bir video değil bir KANAL; aynı görünselerdi
   * kullanıcı "bu videonun çarpanı" ile "bu kanalın istikrarı"nı kıyaslardı.
   */
  if (score.type === 'channel') {
    const hits = Math.round(score.hitRate * score.uploads);
    const age =
      score.channelAgeDays === null
        ? 'kuruluş tarihi bilinmiyor'
        : `${Math.round(score.channelAgeDays)} günlük kanal`;
    return (
      <span
        title={[
          `Yükselen kanal: son ${score.uploads} videonun ${hits} tanesi hem abone sayısını hem izlenme tabanını aştı. ${age}.`,
          confidenceTitle(score),
        ]
          .filter(Boolean)
          .join('\n')}
        className={cx(
          'tnum inline-flex items-center gap-1 rounded border border-accent bg-bg/90 px-2 py-0.5 font-semibold text-[10.5px] text-accent',
          score.lowConfidence && 'opacity-70',
        )}
      >
        {score.channelAgeDays === null ? 'yeni' : `${Math.round(score.channelAgeDays)}g`}
        <span className="text-muted">·</span>
        {`${hits}/${score.uploads}`}
      </span>
    );
  }

  const tone =
    score.value >= 10
      ? 'bg-heat-mega'
      : score.value >= 5
        ? 'bg-heat-hot'
        : score.value >= 2
          ? 'bg-heat-warm'
          : 'bg-surface-2';

  return (
    <span
      className={cx(
        'tnum inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-bold text-[11px] text-bg',
        tone,
        // Düşük güven: soluk ve kesikli çerçeve — sayı doğru ama kanıt ince.
        score.lowConfidence && 'border border-dashed border-bg/40 opacity-60',
      )}
      title={confidenceTitle(score)}
    >
      {score.value >= 10 && <span aria-hidden="true">🔥</span>}
      {multiplier(score.value)}
    </span>
  );
}
