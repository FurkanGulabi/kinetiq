'use client';

/**
 * Single-page workspace (ARCHITECTURE §10.1). The live 3D view fills the window as the page
 * background. Above it float, in glass: the fixed top bar (connection, machine state, Leveling,
 * Settings, Reset layout, Hold/Reset), alert cards under it, the view toolbar, and the draggable,
 * collapsible widgets Position & Jog, Job and Probe Z.
 *
 * Safety: the top bar never moves, never collapses and stays above every widget and sheet, so
 * Hold and Reset are always one click away.
 */
import { AlertTriangle, LayoutTemplate, Octagon, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { resetLayout, TOP_BAR } from '@/lib/ui/layout';
import { Button } from '@/components/ui/Button';
import { ProbeSection } from '@/components/position/ProbeSection';
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
  loading: () => <div className="kq-scene-bg fixed inset-0 z-0" aria-hidden />,
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

  // Widgets read their remembered layout from localStorage, so they render on the client only.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const machine = useMachine((s) => s);
  const stateView = machineStateView(machine);
  const errorMessage = connectionErrorMessage(machine);
  const backendDown = machine.backend === 'offline';

  return (
    <div className="h-full overflow-hidden">
      <VisualisationPanel />

      <header
        className="glass-bar fixed inset-x-0 top-0 z-40 flex items-center gap-4 px-4"
        style={{ height: TOP_BAR }}
      >
        {/* Width budget: below 1440 px the wordmark goes and the connection fields narrow; below
            1600 px Leveling and Settings are icon-only. Hold and Reset never shrink. */}
        <span className="flex shrink-0 items-center gap-4 max-[1439px]:hidden">
          <Wordmark />
          <span className="h-5 w-px bg-line" aria-hidden />
        </span>
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
        <Button
          variant="ghost"
          onClick={resetLayout}
          title="Reset layout: put the widgets back in their default places"
          aria-label="Reset layout"
          className="w-8 px-0!"
        >
          <LayoutTemplate size={15} aria-hidden />
        </Button>
        <MachineControls />
      </header>

      {/* Alert cards hang from the top bar, above widgets; the alarm card cannot be dismissed. */}
      <div
        className="pointer-events-none fixed inset-x-0 z-[35] flex flex-col items-center gap-2 px-4"
        style={{ top: TOP_BAR + 8 }}
      >
        {stateView?.label === 'Alarm' && !backendDown ? (
          <div role="status" className="kq-alert glass pointer-events-auto flex max-w-[760px] items-center gap-2.5 px-4 py-2.5 text-[13px] text-ink-2">
            <Octagon size={15} className="shrink-0 text-crit" aria-hidden />
            <span>
              Controller is in <span className="text-ink">Alarm</span>. Motion is blocked until you{' '}
              <span className="text-ink">Home</span> ($H) or <span className="text-ink">Unlock</span> ($X). Reset alone
              does not clear an alarm when homing is enabled.
            </span>
          </div>
        ) : null}

        {backendDown ? (
          <div role="alert" className="kq-alert glass pointer-events-auto flex max-w-[760px] items-center gap-2.5 border-crit/50 px-4 py-2.5 text-[13px] text-ink">
            <AlertTriangle size={15} className="shrink-0 text-crit" aria-hidden />
            <span>
              {machine.backendError ?? 'Kinetiq server unreachable'} — machine state unknown. Reconnecting…
            </span>
          </div>
        ) : null}

        {errorMessage && !backendDown ? (
          <div role="alert" className="kq-alert glass pointer-events-auto flex max-w-[760px] items-center gap-2.5 py-2 pr-2 pl-4 text-[13px] text-ink">
            <AlertTriangle size={15} className="shrink-0 text-crit" aria-hidden />
            <span className="flex-1">{errorMessage}</span>
            <button
              type="button"
              onClick={clearConnectionError}
              className="pressable rounded-md p-1.5 text-ink-3 hover-fine:bg-surface-2 hover-fine:text-ink"
              aria-label="Dismiss"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>

      {mounted ? (
        <>
          <PositionPanel />
          <JobPanel />
          <ProbeSection />
        </>
      ) : null}
    </div>
  );
}
