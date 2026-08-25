import { useCallback, useEffect, useRef, useState } from 'react';
import { cx, Panel } from './components/ui.js';
import { ControlPanel } from './features/control/ControlPanel.js';
import { PoolGrid } from './features/pool/PoolGrid.js';
import { FunnelStrip } from './features/telemetry/FunnelStrip.js';
import { RadarTerminal } from './features/terminal/RadarTerminal.js';
import { WsClient } from './lib/ws-client.js';
import { useRealtime } from './store/realtime.js';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export function App() {
  const apply = useRealtime((s) => s.apply);
  const setConnection = useRealtime((s) => s.setConnection);
  const setProtocolMismatch = useRealtime((s) => s.setProtocolMismatch);
  const protocolMismatch = useRealtime((s) => s.protocolMismatch);
  const fatal = useRealtime((s) => s.fatal);
  const phase = useRealtime((s) => s.phase);

  const [terminalOpen, setTerminalOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    const client = new WsClient({
      url: WS_URL,
      onEvent: apply,
      onState: setConnection,
      onProtocolMismatch: setProtocolMismatch,
    });
    client.connect();
    return () => client.disconnect();
  }, [apply, setConnection, setProtocolMismatch]);

  // ⌘J / Ctrl+J terminali açar kapatır.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setTerminalOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg">
      <FunnelStrip />

      {protocolMismatch !== null && (
        <Banner tone="danger">
          Sunucu protokol sürümü {protocolMismatch}, arayüz farklı. Sunucuyu ve arayüzü yeniden
          derleyin.
        </Banner>
      )}
      {fatal !== null && <Banner tone="danger">Tarama hatası: {fatal}</Banner>}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <Panel
          title="Kontrol"
          className="h-[72vh] w-full shrink-0 border-b md:h-auto md:w-[320px] md:border-r md:border-b-0"
        >
          <ControlPanel onToast={showToast} />
        </Panel>

        <main className="flex min-h-[72vh] min-w-0 flex-1 flex-col md:min-h-0">
          <div className="flex min-h-0 flex-1 flex-col">
            <PoolGrid onToast={showToast} />
          </div>

          <Panel
            title="Radar terminali"
            className={cx('border-t', terminalOpen ? 'h-[240px] shrink-0' : 'shrink-0')}
            right={
              <button
                type="button"
                onClick={() => setTerminalOpen((open) => !open)}
                className="text-[11px] text-muted hover:text-ink"
                aria-expanded={terminalOpen}
              >
                {terminalOpen ? 'gizle' : 'göster'} (⌘J)
              </button>
            }
          >
            {terminalOpen && <RadarTerminal />}
          </Panel>
        </main>
      </div>

      {/* Yakalamalar kısılmış şekilde duyurulur; her log satırını seslendirmek düşmanca olurdu. */}
      <p className="sr-only" aria-live="polite">
        {phase === 'crawling' ? 'Tarama sürüyor' : ''}
      </p>

      {toast !== null && (
        <div className="-translate-x-1/2 fixed bottom-6 left-1/2 rounded border border-line bg-surface-2 px-4 py-2 text-[12px] shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'danger' | 'warn'; children: React.ReactNode }) {
  return (
    <div
      className={cx(
        'shrink-0 px-3 py-1.5 text-[12px]',
        tone === 'danger' ? 'bg-danger/15 text-danger' : 'bg-heat-hot/15 text-heat-hot',
      )}
    >
      {children}
    </div>
  );
}
