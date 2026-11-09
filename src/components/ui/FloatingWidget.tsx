'use client';

/**
 * Floating glass widget (ARCHITECTURE §10.1): drag by the header, collapse to the header, click
 * to bring to front. Position and collapsed state are remembered (lib/ui/layout.ts).
 *
 * Motion (apple-design / emil-design-eng):
 * - Dragging is 1:1 with the pointer and keeps the grab offset; past the viewport edge it meets
 *   rubber-band resistance instead of a wall.
 * - On release the widget is thrown: momentum is projected, the landing point is kept on screen
 *   (and snaps to an edge when close), and a spring carries the release velocity there.
 * - Grabbing a widget mid-flight stops it where it is on screen (interruptible).
 * - Collapse folds the body with CSS rows + a soft fade; a widget that grows past the bottom edge
 *   moves up as it grows.
 * Reduced motion: no springs or throw (moves land immediately), fades only.
 */
import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  bringToFront,
  clampToViewport,
  defaultSlot,
  EDGE,
  getLayout,
  reportWidgetRect,
  setWidgetCollapsed,
  setWidgetPosition,
  TOP_BAR,
  useLayout,
  WIDGET_WIDTH,
  type WidgetId,
} from '@/lib/ui/layout';
import { createSpring2D, project, rubberband, SPRING_MOVE, SPRING_THROW, VelocityTracker, type Spring2D } from '@/lib/ui/spring';

const DRAG_THRESHOLD = 3; // px before a press on the header becomes a drag
const SNAP_DISTANCE = 28; // px from an edge at which a landing point snaps to it
const HEADER_HEIGHT = 44;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Interactive elements inside the header keep their own behaviour (no drag, no double-click collapse). */
function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('button, input, select, textarea, a, [role="radio"], [data-no-drag]');
}

export function FloatingWidget({
  id,
  title,
  actions,
  summary,
  index = 0,
  children,
}: {
  id: WidgetId;
  title: string;
  /** Header content shown in both states (e.g. a status badge). */
  actions?: React.ReactNode;
  /** Compact state shown in the header while collapsed (e.g. "Running · 62 %"). */
  summary?: React.ReactNode;
  /** Entrance stagger slot. */
  index?: number;
  children: React.ReactNode;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const springRef = useRef<Spring2D | null>(null);
  const bodyId = useId();
  const collapsed = useLayout((s) => s.widgets[id].collapsed);
  const z = useLayout((s) => 10 + s.order.indexOf(id));
  const resetCount = useLayout((s) => s.resetCount);
  const [dragging, setDragging] = useState(false);
  const width = WIDGET_WIDTH[id];

  /** Height the widget will have once settled: just the header while collapsed (the fold may still be animating). */
  const settledHeight = () => {
    const el = outerRef.current!;
    return getLayout().widgets[id].collapsed ? HEADER_HEIGHT + 2 : el.offsetHeight;
  };

  const report = () => {
    const el = outerRef.current;
    const spring = springRef.current;
    if (!el || !spring) return;
    reportWidgetRect(id, { x: spring.x, y: spring.y, width: el.offsetWidth, height: el.offsetHeight });
  };

  // Place once, before paint: saved position (kept on screen) or the default slot.
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const apply = (x: number, y: number) => {
      el.style.transform = `translate3d(${Math.round(x * 2) / 2}px, ${Math.round(y * 2) / 2}px, 0)`;
    };
    const spring = createSpring2D(0, 0, apply, (x, y) => {
      setWidgetPosition(id, x, y);
      report();
    });
    springRef.current = spring;
    const saved = getLayout().widgets[id];
    const h = settledHeight();
    const start = saved.x !== null && saved.y !== null ? { x: saved.x, y: saved.y } : defaultSlot(id, h);
    const p = clampToViewport(start.x, start.y, el.offsetWidth, h);
    spring.set(p.x, p.y);
    el.style.visibility = 'visible';
    report();
    return () => {
      spring.stop();
      reportWidgetRect(id, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Reset layout: glide back to the default slot.
  const firstReset = useRef(resetCount);
  useEffect(() => {
    if (resetCount === firstReset.current) return;
    const el = outerRef.current;
    const spring = springRef.current;
    if (!el || !spring) return;
    // Collapse state may change in the same reset; measure after it applies.
    requestAnimationFrame(() => {
      const h = settledHeight();
      const target = defaultSlot(id, h);
      const p = clampToViewport(target.x, target.y, el.offsetWidth, h);
      if (prefersReducedMotion()) {
        spring.set(p.x, p.y);
        setWidgetPosition(id, p.x, p.y);
        report();
      } else spring.to(p.x, p.y, SPRING_MOVE);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetCount, id]);

  // Keep on screen when the window shrinks, and when the widget grows past the bottom edge
  // (opening a collapsed widget near the bottom makes it grow upward).
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const keepOnScreen = () => {
      const spring = springRef.current;
      if (!spring || draggingRef.current || spring.moving) return; // a landing spring clamps itself
      const p = clampToViewport(spring.x, spring.y, el.offsetWidth, el.offsetHeight);
      if (Math.abs(p.x - spring.x) > 0.5 || Math.abs(p.y - spring.y) > 0.5) {
        spring.set(p.x, p.y);
        setWidgetPosition(id, p.x, p.y);
      }
      report();
    };
    const ro = new ResizeObserver(keepOnScreen);
    ro.observe(el);
    window.addEventListener('resize', keepOnScreen);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', keepOnScreen);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // --- drag ------------------------------------------------------------------
  const draggingRef = useRef(false);
  const press = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const tracker = useRef(new VelocityTracker());

  const bounds = () => {
    const el = outerRef.current!;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      minX: EDGE,
      maxX: Math.max(EDGE, vw - el.offsetWidth - EDGE),
      minY: TOP_BAR + EDGE,
      maxY: Math.max(TOP_BAR + EDGE, vh - el.offsetHeight - EDGE),
      vw,
      vh,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || press.current || isInteractive(e.target)) return;
    const spring = springRef.current;
    if (!spring) return;
    spring.stop(); // catch it where it is on screen
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: spring.x, originY: spring.y, moved: false };
    tracker.current.reset();
    tracker.current.add(e.clientX, e.clientY, e.timeStamp);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pointerId) return;
    const dx = e.clientX - p.startX;
    const dy = e.clientY - p.startY;
    if (!p.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      p.moved = true;
      draggingRef.current = true;
      setDragging(true);
    }
    tracker.current.add(e.clientX, e.clientY, e.timeStamp);
    const b = bounds();
    const resist = (v: number, min: number, max: number, dim: number) =>
      v < min ? min + rubberband(v - min, dim) : v > max ? max + rubberband(v - max, dim) : v;
    const x = resist(p.originX + dx, b.minX, b.maxX, b.vw);
    const y = resist(p.originY + dy, b.minY, b.maxY, b.vh);
    springRef.current?.set(x, y);
  };

  const endDrag = (e: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pointerId) return;
    press.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!p.moved) return;
    draggingRef.current = false;
    setDragging(false);
    const spring = springRef.current;
    if (!spring) return;

    const reduced = prefersReducedMotion();
    const v = cancelled || reduced ? { x: 0, y: 0 } : tracker.current.velocity(e.timeStamp);
    const b = bounds();
    let tx = Math.min(Math.max(spring.x + project(v.x), b.minX), b.maxX);
    let ty = Math.min(Math.max(spring.y + project(v.y), b.minY), b.maxY);
    if (tx - b.minX < SNAP_DISTANCE) tx = b.minX;
    else if (b.maxX - tx < SNAP_DISTANCE) tx = b.maxX;
    if (ty - b.minY < SNAP_DISTANCE) ty = b.minY;
    else if (b.maxY - ty < SNAP_DISTANCE) ty = b.maxY;

    if (reduced) {
      spring.set(tx, ty);
      setWidgetPosition(id, tx, ty);
      report();
      return;
    }
    const thrown = Math.hypot(v.x, v.y) > 400;
    spring.to(tx, ty, thrown ? SPRING_THROW : SPRING_MOVE, v);
  };

  const toggle = () => setWidgetCollapsed(id, !collapsed);

  return (
    <div
      ref={outerRef}
      className="kq-float"
      data-dragging={dragging}
      data-collapsed={collapsed}
      style={{ width, zIndex: z, visibility: 'hidden' }}
      onPointerDownCapture={() => bringToFront(id)}
    >
      <section
        aria-label={title}
        className="kq-float-body glass flex flex-col overflow-hidden"
        style={{ ['--kq-stagger' as string]: `${index * 50}ms` }}
      >
        <header
          className="kq-drag-handle flex shrink-0 items-center gap-2 pr-3 pl-2 select-none"
          style={{ height: HEADER_HEIGHT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
          onDoubleClick={(e) => {
            if (!isInteractive(e.target)) toggle();
          }}
          title="Drag to move · double-click to collapse"
        >
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            className="pressable flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover-fine:bg-surface-2 hover-fine:text-ink"
          >
            <ChevronDown size={14} className="kq-chevron" aria-hidden />
          </button>
          <h2 className="panel-label shrink-0">{title}</h2>
          <div className="kq-summary flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-[12px] text-ink-2" aria-hidden={!collapsed}>
            {summary}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2 text-[12px] text-ink-3">{actions}</div> : null}
        </header>
        <div id={bodyId} className="kq-collapse" data-collapsed={collapsed} inert={collapsed || undefined}>
          <div className="kq-collapse-inner">
            <div
              className="overflow-y-auto px-4 pb-4"
              style={{ maxHeight: `calc(100vh - ${TOP_BAR + 2 * EDGE + HEADER_HEIGHT}px)` }}
            >
              {children}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
