'use client';

/**
 * Floating widget layout (ARCHITECTURE §10.1): position, collapsed state and stacking order of
 * each widget, remembered per browser. Positions are viewport pixels of the widget's top-left
 * corner; null means "use the default slot" (first visit, or after Reset layout).
 *
 * Live on-screen rectangles are kept here too (not persisted) so the 3D view can frame its
 * content in the area the widgets leave free.
 */
import { useSyncExternalStore } from 'react';

export type WidgetId = 'position' | 'job' | 'probe';

export interface WidgetLayout {
  x: number | null;
  y: number | null;
  collapsed: boolean;
}

export interface WidgetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutState {
  widgets: Record<WidgetId, WidgetLayout>;
  /** Back to front. */
  order: WidgetId[];
  /** Bumped by Reset layout so widgets animate back to their default slots. */
  resetCount: number;
}

/** Top bar height and the gap kept between widgets and the viewport edges. */
export const TOP_BAR = 48;
export const EDGE = 12;
/** Space kept clear at the bottom for the 3D view toolbar when choosing default slots. */
export const TOOLBAR_SPACE = 64;

export const WIDGET_WIDTH: Record<WidgetId, number> = {
  position: 560,
  job: 480,
  probe: 400,
};

const STORAGE_KEY = 'kinetiq.layout.v1';

const DEFAULTS: Record<WidgetId, WidgetLayout> = {
  position: { x: null, y: null, collapsed: false },
  job: { x: null, y: null, collapsed: false },
  probe: { x: null, y: null, collapsed: true },
};

let state: LayoutState = {
  widgets: structuredClone(DEFAULTS),
  order: ['probe', 'job', 'position'],
  resetCount: 0,
};
const rects: Partial<Record<WidgetId, WidgetRect>> = {};
const listeners = new Set<() => void>();
const rectListeners = new Set<() => void>();
let loaded = false;

function emit() {
  for (const l of listeners) l();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ widgets: state.widgets, order: state.order }));
  } catch {
    // Storage is a convenience: private mode or a full quota just means defaults next time.
  }
}

function load() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<LayoutState>;
    const widgets = structuredClone(DEFAULTS);
    for (const id of Object.keys(DEFAULTS) as WidgetId[]) {
      const w = saved.widgets?.[id];
      if (!w) continue;
      widgets[id] = {
        x: typeof w.x === 'number' && Number.isFinite(w.x) ? w.x : null,
        y: typeof w.y === 'number' && Number.isFinite(w.y) ? w.y : null,
        collapsed: typeof w.collapsed === 'boolean' ? w.collapsed : DEFAULTS[id].collapsed,
      };
    }
    const order = Array.isArray(saved.order)
      ? (saved.order.filter((id) => id in DEFAULTS) as WidgetId[])
      : [];
    for (const id of state.order) if (!order.includes(id)) order.unshift(id);
    state = { ...state, widgets, order };
  } catch {
    // Corrupt entry: keep defaults.
  }
}

const getSnapshot = () => state;
const getServerSnapshot = () => state;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLayout<T>(selector: (s: LayoutState) => T): T {
  load();
  return selector(useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot));
}

export function getLayout(): LayoutState {
  load();
  return state;
}

export function setWidgetPosition(id: WidgetId, x: number, y: number) {
  state = { ...state, widgets: { ...state.widgets, [id]: { ...state.widgets[id], x, y } } };
  persist();
  emit();
}

export function setWidgetCollapsed(id: WidgetId, collapsed: boolean) {
  state = { ...state, widgets: { ...state.widgets, [id]: { ...state.widgets[id], collapsed } } };
  persist();
  emit();
}

export function bringToFront(id: WidgetId) {
  if (state.order[state.order.length - 1] === id) return;
  state = { ...state, order: [...state.order.filter((w) => w !== id), id] };
  persist();
  emit();
}

export function resetLayout() {
  state = {
    widgets: structuredClone(DEFAULTS),
    order: ['probe', 'job', 'position'],
    resetCount: state.resetCount + 1,
  };
  persist();
  emit();
}

/**
 * Default slot for a widget: Position top-left, Job top-right, Probe bottom-right (collapsed, it
 * grows upward when opened). `height` is the widget's current height.
 */
export function defaultSlot(id: WidgetId, height: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const top = TOP_BAR + EDGE;
  switch (id) {
    case 'position':
      return { x: EDGE, y: top };
    case 'job':
      return { x: vw - WIDGET_WIDTH.job - EDGE, y: top };
    case 'probe':
      return { x: vw - WIDGET_WIDTH.probe - EDGE, y: Math.max(top, vh - TOOLBAR_SPACE - height - EDGE) };
  }
}

/** Keep a widget fully on screen when it fits; when taller than the viewport, keep its header visible. */
export function clampToViewport(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minX = EDGE;
  const maxX = Math.max(minX, vw - width - EDGE);
  const minY = TOP_BAR + EDGE;
  const maxY = Math.max(minY, vh - height - EDGE);
  return { x: Math.min(Math.max(x, minX), maxX), y: Math.min(Math.max(y, minY), maxY) };
}

// --- live rectangles (for the 3D view) --------------------------------------

export function reportWidgetRect(id: WidgetId, rect: WidgetRect | null) {
  const prev = rects[id];
  if (rect && prev && prev.x === rect.x && prev.y === rect.y && prev.width === rect.width && prev.height === rect.height) return;
  if (rect) rects[id] = rect;
  else delete rects[id];
  for (const l of rectListeners) l();
}

export function getWidgetRects(): WidgetRect[] {
  return Object.values(rects).filter((r): r is WidgetRect => !!r);
}

export function subscribeWidgetRects(listener: () => void) {
  rectListeners.add(listener);
  return () => rectListeners.delete(listener);
}
