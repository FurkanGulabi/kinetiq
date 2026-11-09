'use client';

/**
 * Widget 1 — Connection (top bar). docs/ARCHITECTURE.md §10.2, docs/API_REFERENCE.md §5.
 */
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { closePort, listPorts, loadPrefs, openPort } from '@/lib/cnc/client';
import { connectionView, controllerIdentity } from '@/lib/cnc/derive';
import { BAUDRATES, DEFAULT_BAUDRATE } from '@/lib/cnc/protocol';
import { useMachine } from '@/lib/cnc/store';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { StatusBadge, type BadgeIcon, type Tone } from '@/components/ui/StatusBadge';

const STATUS_BADGE: Record<string, { tone: Tone; icon: BadgeIcon }> = {
  disconnected: { tone: 'neutral', icon: 'idle' },
  connecting: { tone: 'neutral', icon: 'busy' },
  connected: { tone: 'ok', icon: 'dot' },
  error: { tone: 'crit', icon: 'warning' },
};

export function ConnectionBar() {
  const machine = useMachine((s) => s);
  const view = connectionView(machine);
  const identity = controllerIdentity(machine);
  const backendOnline = machine.backend === 'online';
  const { connection, ports, portsLoaded, baudrates } = machine;

  const [selectedPort, setSelectedPort] = useState<string | undefined>(undefined);
  const [selectedBaud, setSelectedBaud] = useState<number>(DEFAULT_BAUDRATE);

  // Restore last-used choices once on mount.
  useEffect(() => {
    const prefs = loadPrefs();
    if (prefs.port) setSelectedPort(prefs.port);
    if (prefs.baudrate) setSelectedBaud(prefs.baudrate);
  }, []);

  // While connected (or attaching), the selects reflect the open port.
  const activePort = connection.phase === 'closed' ? selectedPort : connection.port ?? undefined;
  const activeBaud = connection.phase === 'closed' ? selectedBaud : connection.baudrate ?? selectedBaud;

  const portOptions = useMemo(() => {
    const options = ports.map((p) => ({
      value: p.port,
      label: p.port,
      hint: p.inuse ? 'in use' : p.manufacturer,
    }));
    if (activePort && !options.some((o) => o.value === activePort)) {
      options.unshift({ value: activePort, label: activePort, hint: 'not detected' });
    }
    return options;
  }, [ports, activePort]);

  const baudOptions = useMemo(
    () =>
      Array.from(new Set([...BAUDRATES, ...baudrates]))
        .sort((a, b) => b - a)
        .map((b) => ({ value: String(b), label: String(b) })),
    [baudrates],
  );

  const isOpenOrOpening = connection.phase !== 'closed';
  const badge = STATUS_BADGE[view.status];

  const connectDisabledReason = !backendOnline
    ? 'Kinetiq server unreachable'
    : !activePort
      ? 'Select a serial port'
      : undefined;

  return (
    <div className="-my-1 flex min-w-0 flex-1 items-center gap-3 overflow-hidden py-1">
      <StatusBadge tone={badge.tone} icon={badge.icon} label={view.label} />
      {view.status === 'connected' && view.detail ? (
        <StatusBadge tone="warn" icon="busy" label={view.detail} />
      ) : null}

      <div className="flex shrink-0 items-center gap-1.5">
        <Select
          ariaLabel="Serial port"
          className="w-64 shrink-0 max-[1439px]:w-52"
          value={activePort}
          onValueChange={setSelectedPort}
          options={portOptions}
          placeholder={portsLoaded ? (ports.length ? 'Select port' : 'No ports found') : 'Loading ports…'}
          disabled={isOpenOrOpening || !backendOnline}
        />
        <Button
          variant="ghost"
          className="w-8 px-0"
          aria-label="Refresh port list"
          title="Refresh port list"
          onClick={listPorts}
          disabled={isOpenOrOpening || !backendOnline}
        >
          <RefreshCw size={14} aria-hidden />
        </Button>
        <Select
          ariaLabel="Baud rate"
          className="w-24 shrink-0"
          value={String(activeBaud)}
          onValueChange={(v) => setSelectedBaud(Number(v))}
          options={baudOptions}
          disabled={isOpenOrOpening || !backendOnline}
        />
      </div>

      {connection.phase === 'open' ? (
        <Button variant="secondary" onClick={closePort} disabled={!backendOnline}>
          Disconnect
        </Button>
      ) : (
        <Button
          variant="primary"
          className="min-w-[96px]"
          disabled={connection.phase === 'opening' || Boolean(connectDisabledReason)}
          disabledReason={connection.phase === 'opening' ? 'Connecting…' : connectDisabledReason}
          onClick={() => activePort && openPort(activePort, activeBaud)}
        >
          {connection.phase === 'opening' ? 'Connecting…' : 'Connect'}
        </Button>
      )}

      {view.status === 'connected' && identity ? (
        <span
          className="truncate text-[12px] text-ink-2"
          title={`${connection.port} · ${connection.baudrate} baud${machine.controller.settings?.version ? ` · Grbl-compatible ${machine.controller.settings.version}` : ''}`}
        >
          {identity}
        </span>
      ) : null}
    </div>
  );
}
