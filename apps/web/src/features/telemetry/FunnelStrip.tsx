import { cx } from '../../components/ui.js';
import { compactNumber } from '../../lib/format.js';
import { useRealtime } from '../../store/realtime.js';

/**
 * Huni şeridi.
 *
 * Taramanın verimli olup olmadığını tek bakışta gösterir. En önemli sayı
 * "kanal isteği": sistemin gerçek maliyeti taranan video sayısı değil, harcanan
 * kanal isteğidir — bütçe çubuğu bu yüzden burada.
 */
export function FunnelStrip() {
  const stats = useRealtime((s) => s.stats);
  const connection = useRealtime((s) => s.connection);
  const retryInMs = useRealtime((s) => s.retryInMs);

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-line border-b bg-surface px-3 py-2">
      <span className="flex items-center gap-2 font-semibold text-[13px] tracking-wide">
        <span className="text-accent">◉</span> NEW CHANNEL RADAR
      </span>

      <ConnectionPill state={connection} retryInMs={retryInMs} />

      {stats === null ? (
        <span className="text-[11px] text-muted">tarama bekleniyor</span>
      ) : (
        <>
          <Metric label="incelendi" value={compactNumber(stats.scanned)} />
          <Metric label="yeni kanal" value={String(stats.matched)} accent />
          <Metric
            label="kanal sorgusu"
            value={`${stats.channelFetches}${stats.channelCacheHits > 0 ? ` (${stats.channelCacheHits} önbellek)` : ''}`}
          />
          {stats.http429 > 0 && <Metric label="429" value={String(stats.http429)} warn />}
          <BudgetMeter
            label="kanal bütçesi"
            used={stats.channelFetches}
            cap={stats.channelBudgetCap}
          />
        </>
      )}
    </header>
  );
}

function Metric({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1 text-[11px]">
      <span className="text-muted">{label}</span>
      <span
        className={cx(
          'tnum font-semibold text-[12px]',
          accent === true && 'text-accent',
          warn === true && 'text-danger',
        )}
      >
        {value}
      </span>
    </span>
  );
}

function BudgetMeter({ label, used, cap }: { label: string; used: number; cap: number }) {
  const ratio = cap === 0 ? 0 : Math.min(1, used / cap);
  return (
    <span className="flex items-center gap-1.5 text-[11px]" title={`${used} / ${cap}`}>
      <span className="text-muted">{label}</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
        <span
          className={cx(
            'block h-full rounded-full transition-[width]',
            ratio > 0.85 ? 'bg-danger' : ratio > 0.6 ? 'bg-heat-hot' : 'bg-accent',
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </span>
    </span>
  );
}

function ConnectionPill({ state, retryInMs }: { state: string; retryInMs: number }) {
  const config: Record<string, { text: string; className: string; pulse?: boolean }> = {
    live: { text: '● CANLI', className: 'text-accent', pulse: true },
    connecting: { text: '◌ BAĞLANIYOR', className: 'text-heat-hot' },
    resyncing: { text: '◌ EŞİTLENİYOR', className: 'text-heat-hot' },
    offline: {
      text: `✕ ÇEVRİMDIŞI — ${Math.ceil(retryInMs / 1000)} sn`,
      className: 'text-danger',
    },
  };
  const pill = config[state] ?? config.connecting;
  if (pill === undefined) return null;
  return (
    <span
      className={cx('font-semibold text-[11px]', pill.className, pill.pulse === true && 'pulse')}
    >
      {pill.text}
    </span>
  );
}
