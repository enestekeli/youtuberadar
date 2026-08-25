import type { PoolItem } from '@hype/shared';
import { memo, useState } from 'react';
import { Button, cx } from '../../components/ui.js';
import {
  compactNumber,
  duration,
  relativeAge,
  thumbnailFor,
  youtubeUrl,
} from '../../lib/format.js';
import { HypeBadge } from './HypeBadge.js';

export interface CardActions {
  onDiscard: (videoId: string) => void;
  onExport: (videoId: string) => void;
  onReseed: (videoId: string) => void;
}

/**
 * Havuz kartı.
 *
 * `memo` ile sarılı ve store'da kartlar referans-kararlı tutuluyor: bir kartın
 * skoru güncellenince yalnızca o kart yeniden render ediliyor, grid'in tamamı
 * değil.
 */
export const VideoCard = memo(function VideoCard({
  item,
  actions,
  focused,
}: {
  item: PoolItem;
  actions: CardActions;
  focused?: boolean | undefined;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <article
      aria-label={`${item.title}, ${item.score.type === 'pending' ? 'skorlanıyor' : `${item.score.value.toFixed(1)} kat`}, ${item.channelName ?? 'bilinmeyen kanal'}`}
      className={cx(
        'group flex flex-col overflow-hidden rounded border bg-surface transition-colors',
        focused ? 'border-accent' : 'border-line hover:border-muted',
      )}
    >
      <div className="relative aspect-video shrink-0 bg-surface-2">
        {imageFailed ? (
          <div className="flex h-full items-center justify-center text-muted text-xl">▤</div>
        ) : (
          <img
            src={thumbnailFor(item.thumbnailUrl, item.videoId)}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover"
          />
        )}
        <div className="absolute top-1.5 right-1.5">
          <HypeBadge score={item.score} />
        </div>
        {item.durationSec !== null && (
          <span className="tnum absolute right-1.5 bottom-1.5 rounded bg-bg/85 px-1 py-0.5 text-[10px] text-ink">
            {duration(item.durationSec)}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <h3 className="line-clamp-2 text-[12.5px] leading-snug" title={item.title}>
          {item.title}
        </h3>

        <p className="flex items-center gap-1 truncate text-[11px] text-muted">
          {item.channelIsHot && (
            <span
              role="img"
              title="Kanalın tipik izlenmesi abone sayısını aşıyor"
              aria-label="öne çıkan kanal"
            >
              ★
            </span>
          )}
          <span className="truncate">{item.channelName ?? '—'}</span>
          {item.subsText !== null && <span className="shrink-0">· {item.subsText}</span>}
        </p>

        <p className="tnum text-[11px] text-muted">
          {compactNumber(item.views)} izlenme · {relativeAge(item.ageDays)} ·{' '}
          {compactNumber(item.vpd)}/gün
        </p>

        {item.score.type === 'channel' && <ChannelSignals item={item} />}

        {(item.topicMatches.length > 0 || item.seedQuery !== null) && (
          <p
            className="truncate border-line border-l-2 pl-1.5 text-[10.5px] text-muted"
            title={`Tohum: ${item.seedQuery ?? 'manuel'}; eşleşen: ${item.topicMatches.join(', ') || '—'}`}
          >
            <span className="text-ink">
              Niş{item.topicScore === null ? '' : ` %${Math.round(item.topicScore * 100)}`}
            </span>
            {item.topicMatches.length > 0 && ` · ${item.topicMatches.join(', ')}`}
            {item.seedQuery !== null && ` · ↳ ${item.seedQuery}`}
          </p>
        )}

        {item.receipts !== null && <Receipts item={item} />}

        <div className="mt-auto flex gap-1 pt-1.5">
          <a
            href={youtubeUrl(item.videoId)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-8 flex-1 items-center justify-center rounded border border-line bg-surface-2 text-[12px] hover:border-muted"
          >
            ▶ Aç
          </a>
          <Button
            onClick={() => actions.onExport(item.videoId)}
            title="Metadatayı JSON olarak analiz için hazırla"
            aria-label="Analize gönder"
          >
            ⤴
          </Button>
          <Button
            onClick={() => actions.onReseed(item.videoId)}
            title="Taramayı buradan devam ettir"
            aria-label="Buradan yeniden tohumla"
          >
            ◎
          </Button>
          <Button
            variant="danger"
            onClick={() => actions.onDiscard(item.videoId)}
            title="Havuzdan çıkar (bir daha gelmez)"
            aria-label="Çöpe at"
          >
            🗑
          </Button>
        </div>
      </div>
    </article>
  );
});

function ChannelSignals({ item }: { item: PoolItem }) {
  if (item.score.type !== 'channel') return null;
  const age = item.score.channelAgeDays;
  const median = item.receipts?.baselineMedian ?? null;
  const hits = Math.round(item.score.hitRate * item.score.uploads);

  return (
    <div className="grid grid-cols-3 border-line border-y py-1.5">
      <Signal label="kanal yaşı" value={age === null ? '—' : `${Math.round(age)} gün`} />
      <Signal label="medyan" value={median === null ? '—' : compactNumber(median)} />
      <Signal label="isabet" value={`${hits}/${item.score.uploads}`} />
    </div>
  );
}

function Signal({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0 border-line border-r px-1.5 last:border-r-0">
      <span className="block truncate text-[9px] text-muted uppercase">{label}</span>
      <span className="tnum block truncate font-semibold text-[11px] text-ink">{value}</span>
    </span>
  );
}

/**
 * "Makbuzlar" — çarpanın nereden geldiği.
 *
 * Outlier araçlarının güvenilirlik açığı, ince bir tabandan üretilmiş şişkin
 * çarpanlardır. Kanalın medyanını ve örneklem sayısını göstermek, 40 katlık bir
 * sonucun haklı mı şüpheli mi olduğunu kullanıcının kendisinin görmesini sağlar.
 */
function Receipts({ item }: { item: PoolItem }) {
  const receipts = item.receipts;
  if (receipts === null) return null;

  /*
   * Kanal modunda makbuz BAŞKA bir iddiayı savunuyor: "bu video patladı" değil
   * "bu kanal istikrarlı". Aynı metni göstermek, kullanıcıya kartın neden
   * havuzda olduğunu yanlış anlatırdı.
   */
  const channel = item.score.type === 'channel' ? item.score : null;

  return (
    <details className="group/receipt">
      <summary className="cursor-pointer list-none text-[10.5px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink">
        makbuzlar
      </summary>
      {channel === null ? (
        <p className="tnum mt-1 text-[10.5px] text-muted leading-relaxed">
          Kanalın normali <span className="text-ink">{compactNumber(receipts.baselineMedian)}</span>{' '}
          izlenme ({receipts.baselineN} videonun medyanı). Bu video{' '}
          <span className="text-ink">{compactNumber(item.views)}</span> aldı.
        </p>
      ) : (
        <p className="tnum mt-1 text-[10.5px] text-muted leading-relaxed">
          {channel.channelAgeDays === null ? (
            'Kanalın kuruluş tarihi okunamadı. '
          ) : (
            <>
              Kanal <span className="text-ink">{Math.round(channel.channelAgeDays)} gün</span> önce
              açıldı.{' '}
            </>
          )}
          Son <span className="text-ink">{channel.uploads}</span> videonun medyanı{' '}
          <span className="text-ink">{compactNumber(receipts.baselineMedian)}</span> izlenme
          {/*
            Abone gizliyse "0 tanesi aboneyi aştı" yazmak yalan olurdu: ölçüm
            yapılamadı, sonuç sıfır değil. Kanalı havuza sokan karar zaten
            medyan — isabet yalnızca eldeyse eklenen bir ayrıntı.
          */}
          {channel.lowConfidenceReasons.includes('subs_hidden') ? (
            '; kanal abone sayısını gizliyor. '
          ) : (
            <>
              ; <span className="text-ink">{Math.round(channel.hitRate * channel.uploads)}</span>{' '}
              tanesi abone sayısını da aştı.{' '}
            </>
          )}
          Aşağıdaki video kanalın en çok izlenenidir.
        </p>
      )}
    </details>
  );
}
