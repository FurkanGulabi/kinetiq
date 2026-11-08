'use client';

/**
 * Single-page workspace: top bar with the Connection widget, machine-state badge, machine controls,
 * backend-offline strip and connection errors; Position & Jog (left), Job and the live 3D Visualisation (right).
 */
import { AlertTriangle, Octagon, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { clearConnectionError, startClient } from '@/lib/cnc/client';
import { connectionErrorMessage, machineStateView } from '@/lib/cnc/derive';
import { useMachine } from '@/lib/cnc/store';
import { ConnectionBar } from '@/components/connection/ConnectionBar';
import { MachineControls } from '@/components/safety/MachineControls';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { LevelingPanel } from '@/components/leveling/LevelingPanel';
import { PositionPanel } from '@/components/position/PositionPanel';
import { JobPanel } from '@/components/job/JobPanel';

// three.js is loaded only in the browser and only for this panel.
const VisualisationPanel = dynamic(() => import('@/components/visualisation/VisualisationPanel'), {
  ssr: false,
  loading: () => <section aria-label="Visualisation" className="bg-surface" />,
});
import { StatusBadge, type BadgeIcon } from '@/components/ui/StatusBadge';

function Wordmark() {
  return (
    <span className="flex items-center select-none" aria-label="Kinetiq">
      <span className="text-[13px] font-semibold tracking-[0.12em] text-ink">KINETI</span>
      <span className="relative text-[13px] font-semibold tracking-[0.12em] text-ink">
        Q
        <span aria-hidden className="absolute right-[0.02em] bottom-[0.05em] h-[1.5px] w-[0.55em] origin-left rotate-[38deg] rounded-full bg-accent" />
      </span>
    </span>
  );
}

const STATE_ICON: Record<string, BadgeIcon> = {
  neutral: 'idle',
  accent: 'play',
  warn: 'warning',
  crit: 'alarm',
  ok: 'dot',
};

export function Workspace() {
  useEffect(() => {
    void startClient();
  }, []);

  const machine = useMachine((s) => s);
  const stateView = machineStateView(machine);
  const errorMessage = connectionErrorMessage(machine);
  const backendDown = machine.backend === 'offline';

  return (
    <div className="flex h-full min-h-[720px] min-w-[1280px] flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
        <Wordmark />
        <div className="h-5 w-px bg-line" aria-hidden />
        <ConnectionBar />
        {stateView ? (
          <StatusBadge
            tone={stateView.tone}
            icon={STATE_ICON[stateView.tone]}
            label={stateView.label.toUpperCase()}
            className="tracking-[0.06em]"
          />
        ) : null}
        <LevelingPanel />
        <SettingsPanel />
        <MachineControls />
      </header>

      {stateView?.label === 'Alarm' && !backendDown ? (
        <div role="status" className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2 text-[13px] text-ink-2">
          <Octagon size={14} className="text-crit" aria-hidden />
          <span>
            Controller is in <span className="text-ink">Alarm</span>. Motion is blocked until you{' '}
            <span className="text-ink">Home</span> ($H) or <span className="text-ink">Unlock</span> ($X). Reset alone
            does not clear an alarm when homing is enabled.
          </span>
        </div>
      ) : null}

      {backendDown ? (
        <div role="alert" className="flex items-center gap-2 border-b border-crit/40 bg-crit/10 px-4 py-2 text-[13px] text-ink">
          <AlertTriangle size={14} className="text-crit" aria-hidden />
          <span>
            {machine.backendError ?? 'Kinetiq server unreachable'} — machine state unknown. Reconnecting…
          </span>
        </div>
      ) : null}

      {errorMessage && !backendDown ? (
        <div role="alert" className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2 text-[13px] text-ink">
          <AlertTriangle size={14} className="text-crit" aria-hidden />
          <span className="flex-1">{errorMessage}</span>
          <button
            type="button"
            onClick={clearConnectionError}
            className="pressable rounded p-1 text-ink-3 hover-fine:text-ink"
            aria-label="Dismiss"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ) : null}

      {/* 1 px gaps let --bg show through as hairlines between flat panels (ARCHITECTURE §10.1). */}
      <main className="grid min-h-0 flex-1 grid-cols-[560px_1fr] gap-px bg-line">
        <PositionPanel />
        <div className="grid min-h-0 grid-rows-[auto_1fr] gap-px">
          <JobPanel />
          <VisualisationPanel />
        </div>
      </main>
    </div>
  );
}
