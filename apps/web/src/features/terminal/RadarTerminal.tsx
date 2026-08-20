import type { LogLevel } from '@hype/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Chip, cx } from '../../components/ui.js';
import { clockTime } from '../../lib/format.js';
import { logBuffer } from '../../store/log-buffer.js';

/** Satır yüksekliği sabit — sanallaştırıcı matematiğinin en ucuz hâli. */
const ROW_HEIGHT = 22;

const LEVEL_STYLES: Record<LogLevel, { color: string; label: string }> = {
  seed: { color: 'text-info', label: 'SEED' },
  visit: { color: 'text-muted', label: 'VISIT' },
  skip: { color: 'text-heat-hot/70', label: 'SKIP' },
  match: { color: 'text-accent', label: 'MATCH' },
  channel: { color: 'text-info', label: 'CHAN' },
  rate: { color: 'text-heat-hot', label: 'RATE' },
  info: { color: 'text-muted', label: 'INFO' },
  warn: { color: 'text-heat-hot', label: 'WARN' },
  error: { color: 'text-danger', label: 'ERROR' },
};

const FILTERS: { key: LogLevel | 'all'; label: string }[] = [
  { key: 'all', label: 'hepsi' },
  { key: 'match', label: 'yakalananlar' },
  { key: 'skip', label: 'elenenler' },
  { key: 'channel', label: 'kanal' },
  { key: 'rate', label: 'hız' },
];

/**
 * Canlı radar terminali.
 *
 * Loglar React state'inde değil; bileşen yalnızca bir sürüm sayacına abone.
 * Sabit yükseklikli satırlar sanallaştırıldığı için 20.000 satırda da akıcı.
 *
 * Takip modu fareyle üzerine gelince ya da yukarı kaydırınca duruyor —
 * okumaya çalıştığınız satır kaçmasın diye.
 */
export function RadarTerminal() {
  const version = useSyncExternalStore(logBuffer.subscribe, logBuffer.getVersion);
  const [filter, setFilter] = useState<LogLevel | 'all'>('all');
  const [search, setSearch] = useState('');
  const [following, setFollowing] = useState(true);
  const [hovering, setHovering] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` harici tampondaki değişimin sinyali
  const indices = useMemo(() => {
    const levels = filter === 'all' ? null : new Set<LogLevel>([filter]);
    return logBuffer.indicesMatching(levels, search);
  }, [version, filter, search]);

  /**
   * `null` = filtre yok, tamponun tamamı görünüyor. Bu durumda indeks dizisi
   * kurulmadığı için satır sayısını doğrudan tampondan alıyoruz.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: tampon sürümüne bağlı
  const gorunenSayi = useMemo(() => indices?.length ?? logBuffer.size, [indices, version]);

  const virtualizer = useVirtualizer({
    count: gorunenSayi,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const paused = hovering || !following;
  const newSincePause = useRef(0);

  useEffect(() => {
    if (paused) {
      newSincePause.current += 1;
      return;
    }
    newSincePause.current = 0;
    if (gorunenSayi > 0) virtualizer.scrollToIndex(gorunenSayi - 1, { align: 'end' });
  }, [gorunenSayi, paused, virtualizer]);

  // Sayaçlar artımlı tutuluyor; bu yalnızca referansı tazeliyor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tampon sürümüne bağlı
  const counts = useMemo(() => ({ ...logBuffer.counts() }), [version]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-line border-b px-3 py-1.5">
        {FILTERS.map((option) => (
          <Chip
            key={option.key}
            active={filter === option.key}
            onClick={() => setFilter(option.key)}
          >
            {option.label}
            {option.key !== 'all' && counts[option.key] !== undefined && (
              <span className="ml-1 text-muted">{counts[option.key]}</span>
            )}
          </Chip>
        ))}
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="logda ara…"
          className="ml-2 w-36 rounded border border-line bg-bg px-2 py-1 text-[11px] outline-none focus:border-accent"
        />
        <span className="ml-auto flex items-center gap-2">
          {/*
            Filtre varken hem eşleşen hem toplam satır yazılıyor. Yalnızca
            toplamı göstermek, ekranda 1 satır dururken "264 satır" diyerek
            filtrenin çalışmadığı izlenimi veriyordu.
          */}
          <span className="tnum text-[11px] text-muted">
            {indices === null
              ? `${logBuffer.size} satır`
              : `${gorunenSayi} / ${logBuffer.size} satır`}
          </span>
          <Button onClick={() => logBuffer.clear()} title="Yalnızca görünümü temizler">
            temizle
          </Button>
        </span>
      </div>

      <div
        ref={parentRef}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 1.5;
          setFollowing(atBottom);
        }}
        // aria-live kapalı: saniyede 20 satır seslendirmek düşmanca olurdu.
        // Yakalamalar App'teki ayrı bir bölgeden kısılmış şekilde duyurulur.
        role="log"
        aria-live="off"
        className="relative min-h-0 flex-1 overflow-y-auto font-mono text-[11.5px] leading-[22px]"
      >
        {gorunenSayi === 0 ? (
          <p className="p-4 text-center text-muted">— radar boşta · tarama bekleniyor —</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              // Filtre yoksa sanal satır sırası doğrudan tampon indeksidir.
              const bufferIndex = indices === null ? virtualRow.index : indices[virtualRow.index];
              const line = bufferIndex === undefined ? undefined : logBuffer.at(bufferIndex);
              if (line === undefined) return null;
              const style = LEVEL_STYLES[line.level];
              return (
                <div
                  key={line.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: ROW_HEIGHT,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className={cx(
                    'flex items-center gap-2 truncate px-3',
                    line.level === 'match' && 'border-accent border-l-2 bg-accent/8',
                  )}
                  title={line.msg}
                >
                  <span className="tnum shrink-0 text-muted">{clockTime(line.ts)}</span>
                  {/* Renk tek başına anlam taşımaz; seviye metin olarak da yazılı. */}
                  <span className={cx('w-12 shrink-0 font-semibold', style.color)}>
                    {style.label}
                  </span>
                  <span className="truncate text-ink">{line.msg}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {paused && gorunenSayi > 0 && (
        <button
          type="button"
          onClick={() => {
            setFollowing(true);
            setHovering(false);
            virtualizer.scrollToIndex(gorunenSayi - 1, { align: 'end' });
          }}
          className="absolute right-6 bottom-6 rounded-full border border-accent bg-surface px-3 py-1.5 text-[11px] text-accent shadow-lg"
        >
          ▼ Takibe dön
        </button>
      )}
    </div>
  );
}
