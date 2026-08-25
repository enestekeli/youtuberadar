import type { PoolItem } from '@hype/shared';
import { useCallback, useMemo, useState } from 'react';
import { Button, cx, EmptyState } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { useRealtime, visiblePool } from '../../store/realtime.js';
import { type CardActions, VideoCard } from './VideoCard.js';

export function PoolGrid({ onToast }: { onToast: (message: string) => void }) {
  /*
   * Havuza REFERANSLA değil, SÜRÜM SAYACIYLA abone oluyoruz.
   *
   * Map yerinde değiştiği için referansı hiç değişmiyor; değişimi sayaç
   * bildiriyor. Böylece her olayda tüm koleksiyonu kopyalamak gerekmiyor.
   */
  const poolVersion = useRealtime((s) => s.poolVersion);
  const phase = useRealtime((s) => s.phase);
  const stats = useRealtime((s) => s.stats);

  const discardLocally = useRealtime((s) => s.discardLocally);
  const enterArchive = useRealtime((s) => s.enterArchive);
  const exitArchive = useRealtime((s) => s.exitArchive);
  const archiveMode = useRealtime((s) => s.archiveMode);
  const restoreLocally = useRealtime((s) => s.restoreLocally);

  const [view, setView] = useState<'channels' | 'all'>('channels');
  const [ageWindow, setAgeWindow] = useState<30 | 60 | 90>(90);
  // biome-ignore lint/correctness/useExhaustiveDependencies: poolVersion havuz değişiminin sinyali
  const items = useMemo(() => {
    const all = visiblePool(useRealtime.getState().pool);
    if (view === 'all') return all;
    return all
      .filter((item) => {
        if (item.score.type === 'pending') return true;
        return (
          item.score.type === 'channel' &&
          item.score.channelAgeDays !== null &&
          item.score.channelAgeDays <= ageWindow
        );
      })
      .sort((a, b) => channelMomentum(b) - channelMomentum(a));
  }, [poolVersion, view, ageWindow]);
  const [busy, setBusy] = useState<string | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

  /**
   * Geçmiş ↔ canlı arasında gidip gelir.
   *
   * Çıkış yolu ŞART: arşiv görünümü havuzun üstüne yazıyor ve tek yönlü
   * olsaydı "geçmiş"e yanlışlıkla basan kullanıcı taramanın sonuçlarını
   * ancak yeni bir tarama başlatarak geri getirebilirdi.
   */
  const toggleArchive = useCallback(async () => {
    setArchiveBusy(true);
    try {
      if (archiveMode) {
        const runId = useRealtime.getState().activeRunId;
        // Tarama sürerken arşive bakılmış olabilir; o sırada gelen yakalamalar
        // yedekte yok. Bu yüzden koşan tarama varsa sunucudan tazesi alınıyor.
        const fresh = runId === null ? null : (await api.videos({ runId, limit: 300 })).items;
        exitArchive(fresh);
        onToast('Canlı havuza dönüldü');
      } else {
        const r = await api.videos({ status: 'all', limit: 300, sort: 'date' });
        enterArchive(r.items);
        onToast(`${r.items.length} geçmiş sonuç yüklendi`);
      }
    } catch {
      onToast(archiveMode ? 'Canlı havuz geri getirilemedi' : 'Geçmiş yüklenemedi');
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveMode, enterArchive, exitArchive, onToast]);

  const actions: CardActions = {
    onDiscard: useCallback(
      (videoId: string) => {
        const snapshot = useRealtime.getState().pool.get(videoId);
        // İyimser: kart hemen gider, sunucu reddederse geri gelir.
        discardLocally(videoId);
        api.discard(videoId).catch(() => {
          if (snapshot !== undefined) restoreLocally(snapshot);
          onToast('Çöpe atma başarısız oldu');
        });
      },
      [discardLocally, restoreLocally, onToast],
    ),

    onExport: useCallback(
      (videoId: string) => {
        setBusy(videoId);
        api
          .exportVideos([videoId], true)
          .then(async (result) => {
            await navigator.clipboard.writeText(JSON.stringify(result.items[0], null, 2));
            onToast('JSON panoya kopyalandı');
          })
          .catch(() => onToast('Export başarısız oldu'))
          .finally(() => setBusy(null));
      },
      [onToast],
    ),

    onReseed: useCallback(
      (videoId: string) => {
        api
          .reseed(videoId)
          .then((r) =>
            onToast(
              r.queued ? 'Sıradaki tohum olarak kuyruğa alındı' : 'Sonraki taramanın ilk tohumu',
            ),
          )
          .catch(() => onToast('İşlem başarısız oldu'));
      },
      [onToast],
    ),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        Görünüm filtresi ve sıralama çubukları KALDIRILDI. Bir taramadan 3–5
        kart çıkıyor; onları çarpan dilimlerine bölmek eleme değil, kaybetme
        riskiydi — nitekim görünmeyen 5x varsayılanı yakalanan bütün kanalları
        gizlemişti. Geriye yalnızca sayaç ve geçmişe erişim kaldı: ikisi de
        filtre değil.
      */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-line border-b px-3 py-1.5">
        <span className="tnum text-[12px] text-ink">
          {items.length} {view === 'channels' ? 'kanal' : 'sonuç'}
          {busy !== null && (
            <span className="ml-2 text-[11px] text-muted">zenginleştiriliyor…</span>
          )}
        </span>
        <div className="flex overflow-hidden rounded border border-line">
          <button
            type="button"
            onClick={() => setView('channels')}
            className={cx(
              'h-7 border-line border-r px-2.5 text-[11px]',
              view === 'channels' ? 'bg-surface-2 text-accent' : 'text-muted hover:text-ink',
            )}
          >
            Yeni kanallar
          </button>
          <button
            type="button"
            onClick={() => setView('all')}
            className={cx(
              'h-7 px-2.5 text-[11px]',
              view === 'all' ? 'bg-surface-2 text-accent' : 'text-muted hover:text-ink',
            )}
          >
            Tümü
          </button>
        </div>
        {view === 'channels' && (
          <div className="flex overflow-hidden rounded border border-line">
            {([30, 60, 90] as const).map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setAgeWindow(days)}
                className={cx(
                  'tnum h-7 border-line border-r px-2 text-[11px] last:border-r-0',
                  ageWindow === days
                    ? 'bg-accent font-semibold text-bg'
                    : 'text-muted hover:text-ink',
                )}
              >
                {days}g
              </button>
            ))}
          </div>
        )}
        <Button
          onClick={() => void toggleArchive()}
          title={
            archiveMode
              ? 'Bu taramanın sonuçlarına geri dön'
              : 'Bu taramanın dışındaki eski sonuçları da göster (veriler hiç silinmiyor)'
          }
        >
          {archiveBusy ? '…' : archiveMode ? '← canlıya dön' : 'geçmiş'}
        </Button>
      </div>

      {archiveMode && (
        <div className="flex shrink-0 items-center gap-2 border-info/30 border-b bg-info/10 px-3 py-1 text-[11px] text-info">
          <span>Geçmiş sonuçlar gösteriliyor — tüm taramalardan.</span>
          {/* Çıkış bandın İÇİNDE de duruyor: uyarıyı okuyan göz çıkışı orada arar. */}
          <button
            type="button"
            onClick={() => void toggleArchive()}
            className="underline underline-offset-2 hover:text-ink"
          >
            canlıya dön
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {items.length === 0 ? (
          <PoolEmptyState
            phase={phase}
            scanned={stats?.scanned ?? 0}
            rejects={stats?.rejects ?? {}}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {items.map((item: PoolItem) => (
              <VideoCard key={item.videoId} item={item} actions={actions} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/*
 * Boş durumların hepsi tasarımlı: hiçbiri "hiçbir şey yok" demiyor.
 *
 * "Filtreler tüm kartları gizliyor" dalı kalktı — görünüm filtresi olmadığı
 * için havuz boşsa gerçekten boştur; kullanıcıyı olmayan bir ayara yollamak
 * artık yanlış olurdu.
 */
function PoolEmptyState({
  phase,
  scanned,
  rejects,
}: {
  phase: string;
  scanned: number;
  rejects: Record<string, number>;
}) {
  if (phase === 'idle' || phase === 'stopped') {
    return (
      <EmptyState
        title="Henüz yeni kanal yok"
        detail="Dönemi ve nişi seçip yeni kanal taramasını başlatın."
      />
    );
  }
  const topReject = Object.entries(rejects).sort((a, b) => b[1] - a[1])[0];
  const topRejectText =
    topReject === undefined
      ? null
      : `${REJECT_LABELS[topReject[0]] ?? topReject[0]}: ${topReject[1]}`;
  return (
    <EmptyState
      title={`Taranıyor… ${scanned} video elendi, henüz yakalanan yok`}
      detail={
        topRejectText === null
          ? 'Öneri ağında geziniliyor; ilk yakalama birkaç dakika sürebilir.'
          : `En sık eleme · ${topRejectText}`
      }
    />
  );
}

const REJECT_LABELS: Record<string, string> = {
  age_too_old: 'video çok eski',
  age_too_young: 'video çok yeni',
  channel_too_old: 'kanal dönemden eski',
  channel_views_low: 'kanal medyanı düşük',
  channel_too_few_uploads: 'kanalda yeterli video yok',
  views_too_low: 'izlenme düşük',
  views_too_high: 'izlenme tavanı aşıldı',
  topic_excluded: 'format dışlandı',
};

function channelMomentum(item: PoolItem): number {
  if (item.score.type !== 'channel') return item.score.type === 'pending' ? Number.MAX_VALUE : 0;
  const median = item.receipts?.baselineMedian ?? 0;
  const age = item.score.channelAgeDays ?? 3650;
  return Math.log10(median + 1) * (0.5 + item.score.hitRate) * (90 / Math.max(age, 14));
}
