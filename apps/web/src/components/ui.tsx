import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Küçük ilkel bileşenler.
 *
 * shadcn/ui jeneratörü yerine elle yazıldı: ihtiyacımız olan beş ilkel için
 * jeneratör kurmanın maliyeti, kazandırdığından fazla. Radix'in erişilebilirlik
 * davranışına ihtiyaç duyan tek yer (popover) native `<details>` ile çözülüyor.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Balonun genişliği ve tetikleyiciyle arasındaki boşluk. */
const TIP_WIDTH = 300;
const TIP_GAP = 10;
/** Fareyi etiketler üzerinde gezdirirken balonun titrememesi için kısa gecikme. */
const TIP_OPEN_DELAY_MS = 120;

interface TipPosition {
  top: number;
  left: number;
  /** Balon rayın solunda mı açıldı? Dar pencerede taşmamak için çevriliyor. */
  flipped: boolean;
}

/** Tetikleyiciyi barındıran kaydırılabilir kutu — balonun yatay dayanağı. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node !== null) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Üzerine gelince açılan açıklama balonu.
 *
 * Native `title` yerine yazıldı: `title` bir saniye gecikiyor, sistem fontuyla
 * çiziliyor ve satır sonu veremiyor — bir ayarın ne işe yaradığını anlatmak için
 * fazla ilkel.
 *
 * PORTAL şart: kontrol paneli `overflow-y-auto`, yani içinde kalan bir balon
 * panelin kenarında kırpılırdı. Sabit konumlandırma tetikleyicinin ekrandaki
 * yerinden hesaplanıyor; panel kaydırılınca ya da pencere boyutlanınca balon
 * sürüklenmesin diye kapanıyor.
 */
export function Tip({
  text,
  children,
  className,
  /** Tetikleyici zaten odaklanabilir bir öğeyse (düğme) sarmalayıcı odak almamalı. */
  focusable = true,
}: {
  text: string;
  children: ReactNode;
  className?: string | undefined;
  focusable?: boolean;
}) {
  const id = useId();
  // Tetikleyici `focusable`'a göre button ya da span oluyor. Ref NESNESİ ikisine
  // birden atanamaz (React ref tipleri değişmez); geri çağırma ref'i ikisini de kabul eder.
  const anchorRef = useRef<HTMLElement | null>(null);
  const setAnchor = useCallback((element: HTMLElement | null) => {
    anchorRef.current = element;
  }, []);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<TipPosition | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    const rect = anchor.getBoundingClientRect();

    /*
     * Yatay dayanak, tetikleyici değil KAYDIRILAN RAYIN kenarı.
     *
     * Etiketin hemen sağına açmak balonu panelin üstüne bindiriyor ve tam da
     * anlattığı alanları kapatıyordu. Rayın dışına çıkınca hiçbir form alanını
     * örtmüyor ve tüm balonlar aynı hizada açılıyor.
     */
    const rail = scrollParent(anchor)?.getBoundingClientRect();
    const fromLeft = rail?.left ?? rect.left;
    const fromRight = rail?.right ?? rect.right;

    // Sağda yer yoksa sola çevir — dar pencerede balon ekran dışına taşmasın.
    const flipped = fromRight + TIP_GAP + TIP_WIDTH > window.innerWidth - 8;
    const left = flipped
      ? Math.max(8, fromLeft - TIP_GAP - TIP_WIDTH)
      : Math.min(fromRight + TIP_GAP, window.innerWidth - TIP_WIDTH - 8);
    setPosition({ top: Math.max(8, rect.top - 8), left, flipped });
  }, []);

  const open = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(place, TIP_OPEN_DELAY_MS);
  }, [place]);

  const close = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setPosition(null);
  }, []);

  useEffect(() => {
    if (position === null) return;
    /*
     * Kaydırma balonu yerinden eder; yeniden hesaplamak yerine kapatmak hem
     * ucuz hem de kullanıcının niyetiyle uyumlu.
     *
     * Ama YALNIZCA tetikleyiciyi taşıyan kaydırma dinlenir. Yakalama modunda
     * tüm pencereyi dinlemek, canlı taramada kendi kendine kayan radar
     * terminali yüzünden balonu saniyede birkaç kez kapatırdı.
     */
    const rail = anchorRef.current === null ? null : scrollParent(anchorRef.current);
    rail?.addEventListener('scroll', close);
    window.addEventListener('scroll', close);
    window.addEventListener('resize', close);
    return () => {
      rail?.removeEventListener('scroll', close);
      window.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [position, close]);

  useEffect(() => () => void (timerRef.current !== null && clearTimeout(timerRef.current)), []);

  /*
   * Balon yüksekliği metne bağlı, önceden bilinemiyor. Çizildikten SONRA ölçüp
   * gerekiyorsa yukarı çekiyoruz — panelin altındaki alanlarda balon ekranın
   * dışına taşıyordu. Boya öncesi çalıştığı için kullanıcı sıçramayı görmez.
   */
  const measure = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null || position === null) return;
      const overflow = element.getBoundingClientRect().bottom - (window.innerHeight - 8);
      if (overflow > 0) {
        setPosition({ ...position, top: Math.max(8, position.top - overflow) });
      }
    },
    [position],
  );

  const handlers = {
    ref: setAnchor,
    'aria-describedby': position === null ? undefined : id,
    onMouseEnter: open,
    onMouseLeave: close,
    onFocus: open,
    onBlur: close,
    onKeyDown: (event: React.KeyboardEvent) => event.key === 'Escape' && close(),
    className,
  };

  return (
    <>
      {focusable ? (
        // Klavyeyle de açılabilmesi için tetikleyici gerçek bir düğme: fare,
        // açıklamaya ulaşmanın tek yolu olmamalı. Tıklama bir işe yaramıyor —
        // ama bu bileşen bir `<label>` içinde durduğu için varsayılan davranışı
        // (girdiye odak sıçratmak) engelliyoruz.
        <button type="button" onClick={(event) => event.preventDefault()} {...handlers}>
          {children}
        </button>
      ) : (
        // Tetikleyici zaten odaklanabilir bir öğe (düğme); bu sarmalayıcı
        // yalnızca fare bölgesi, odak/klavye olayları çocuktan kabarıyor.
        <span {...handlers}>{children}</span>
      )}

      {position !== null &&
        createPortal(
          <div
            id={id}
            ref={measure}
            role="tooltip"
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: TIP_WIDTH,
              // Panelin üstünde ama modal/toast katmanının altında.
              zIndex: 60,
            }}
            className="pointer-events-none rounded border border-line bg-surface-2 px-3 py-2 text-[11.5px] text-ink leading-relaxed shadow-[0_8px_24px_rgba(0,0,0,0.55)]"
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Ayar etiketi + açıklama balonu.
 *
 * Etiketin altı noktalı çizili ve yanında `?` var: balonun varlığı, fareyi
 * oraya götürmeden önce görünür olmalı.
 */
export function HelpTip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tip
      text={text}
      className="cursor-help decoration-muted decoration-dotted underline underline-offset-4 outline-none focus-visible:text-accent"
    >
      {children}
      <span className="ml-1 text-[10px] text-muted">?</span>
    </Tip>
  );
}

export function Panel({
  title,
  right,
  children,
  className,
}: {
  title?: string | undefined;
  right?: ReactNode | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section className={cx('flex flex-col overflow-hidden border-line bg-surface', className)}>
      {title !== undefined && (
        <header className="flex shrink-0 items-center justify-between border-line border-b px-3 py-2">
          <h2 className="font-medium text-[11px] text-muted uppercase tracking-wider">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

type ButtonVariant = 'primary' | 'ghost' | 'danger';

export function Button({
  variant = 'ghost',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant | undefined }) {
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-bg hover:brightness-110 font-semibold',
    ghost: 'border border-line bg-surface-2 text-ink hover:border-muted',
    danger: 'border border-line text-danger hover:border-danger',
  };
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex min-h-8 items-center justify-center gap-1.5 rounded px-3 text-[12px] transition-[filter,border-color] disabled:cursor-not-allowed disabled:opacity-40',
        styles[variant],
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  help,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  /** Üzerine gelince çıkan uzun açıklama — ayarın ne işe yaradığı. */
  help?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    // Girdi children olarak geldiği için Biome ilişkilendirmeyi statik göremiyor;
    // çalışma zamanında label girdiyi sarmalıyor, yani örtük ilişki geçerli.
    // biome-ignore lint/a11y/noLabelWithoutControl: girdi children olarak sarmalanıyor
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-ink">
          {help === undefined ? label : <HelpTip text={help}>{label}</HelpTip>}
        </span>
        {hint !== undefined && <span className="text-[10px] text-muted">{hint}</span>}
      </span>
      {children}
      {error !== undefined && <span className="mt-1 block text-[11px] text-danger">{error}</span>}
    </label>
  );
}

export function NumberInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="number"
      {...props}
      className={cx(
        'tnum w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50',
        props.className,
      )}
    />
  );
}

export function Chip({
  active,
  onClick,
  tone,
  children,
}: {
  active?: boolean | undefined;
  onClick?: (() => void) | undefined;
  tone?: 'mega' | 'hot' | 'warm' | 'neutral' | undefined;
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    mega: 'text-heat-mega',
    hot: 'text-heat-hot',
    warm: 'text-heat-warm',
    neutral: 'text-muted',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'tnum rounded-full border px-2.5 py-1 text-[11px] transition-colors',
        active ? 'border-accent bg-surface-2' : 'border-line hover:border-muted',
        tones[tone ?? 'neutral'],
      )}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  );
}

export function EmptyState({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string | undefined;
  children?: ReactNode | undefined;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      <RadarGlyph />
      <p className="text-[14px] text-ink">{title}</p>
      {detail !== undefined && <p className="max-w-sm text-[12px] text-muted">{detail}</p>}
      {children}
    </div>
  );
}

export function RadarGlyph({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <title>radar</title>
      <circle cx="24" cy="24" r="21" fill="none" stroke="var(--color-line)" />
      <circle cx="24" cy="24" r="13" fill="none" stroke="var(--color-line)" />
      <circle cx="24" cy="24" r="5" fill="none" stroke="var(--color-line)" />
      <g className="radar-sweep">
        <line x1="24" y1="24" x2="24" y2="3" stroke="var(--color-accent)" strokeWidth="1.5" />
      </g>
    </svg>
  );
}

/**
 * Kapatılabilir sayısal sınır.
 *
 * Yanındaki ∞ düğmesi filtreyi tamamen devre dışı bırakır (`null`). Alt ve üst
 * sınır bağımsız kapatılabilir: "abonesi 50 binin altında olsun, alt sınır
 * önemsiz" ya da "kanal boyutu hiç önemli değil" gibi kullanımlar mümkün.
 */
export function BoundedField({
  label,
  hint,
  help,
  error,
  value,
  onChange,
  min,
  max,
  placeholder,
  disabled,
}: {
  label: string;
  hint?: string | undefined;
  help?: string | undefined;
  error?: string | undefined;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number | undefined;
  max?: number | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const off = value === null;
  return (
    <Field label={label} hint={hint} help={help} error={error}>
      <div className="flex items-stretch gap-1">
        {off ? (
          <span className="flex flex-1 items-center rounded border border-line border-dashed bg-bg px-2 py-1.5 text-[12px] text-muted">
            sınırsız
          </span>
        ) : (
          <NumberInput
            disabled={disabled}
            min={min}
            max={max}
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              const next = Number(event.target.value);
              onChange(Number.isFinite(next) ? next : 0);
            }}
          />
        )}
        <Tip
          focusable={false}
          className="flex shrink-0"
          text={
            off
              ? 'Bu sınır şu an kapalı: filtre uygulanmıyor. Düğmeye basınca sayı alanı geri gelir.'
              : 'Bu sınırı tamamen kaldırır — filtre uygulanmaz. Alt ve üst sınırı aynı anda da kapatabilirsiniz.'
          }
        >
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(off ? (min ?? 0) : null)}
            aria-pressed={off}
            aria-label={off ? 'Sınırı yeniden aç' : 'Bu sınırı yok say'}
            className={cx(
              'w-9 rounded border text-[13px] transition-colors disabled:opacity-40',
              off
                ? 'border-accent bg-surface-2 text-accent'
                : 'border-line bg-surface-2 text-muted hover:border-muted hover:text-ink',
            )}
          >
            ∞
          </button>
        </Tip>
      </div>
    </Field>
  );
}
