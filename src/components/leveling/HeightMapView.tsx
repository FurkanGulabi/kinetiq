'use client';

/**
 * Height map as a heatmap (top view, X right, Y up, work coordinates).
 *
 * Diverging encoding (dataviz: polarity around a baseline): blue = below work Z0, red = above,
 * neutral gray at 0, symmetric arms so equal distances read as equal color steps. Values are
 * shown as ink-colored text when the grid is small, always on hover, and in the table view.
 * Planned points are hollow rings, the point being probed has an accent ring, and the job's cutting
 * area is a dashed outline.
 */
import { useMemo, useState } from 'react';
import type { HeightMap } from '@/lib/leveling/heightmap';

// Dark-surface diverging pair (dataviz reference palette): blue pole, neutral midpoint, red pole.
const BLUE = [0x39, 0x87, 0xe5];
const MID = [0x38, 0x38, 0x35];
const RED = [0xe6, 0x67, 0x67];

function mix(a: number[], b: number[], t: number): string {
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Color for z on a symmetric scale [-limit, +limit]. */
export function heightColor(z: number, limit: number): string {
  const t = Math.max(-1, Math.min(1, z / limit));
  return t < 0 ? mix(MID, BLUE, -t) : mix(MID, RED, t);
}

/** Scale half-width: the largest |z|, at least 0.05 mm so a flat map does not look dramatic. */
export function scaleLimit(map: HeightMap): number {
  const values = map.z.flat().filter((v): v is number => v !== null);
  return Math.max(0.05, ...values.map((v) => Math.abs(v)));
}

const fmt = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3);

export function HeightMapView({
  map,
  current,
  jobArea,
}: {
  map: HeightMap;
  current: { i: number; j: number } | null;
  jobArea: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
}) {
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const { xs, ys } = map;
  const limit = useMemo(() => scaleLimit(map), [map]);

  // Cell around each point: halfway to its neighbours (edges extend by half a cell).
  const edges = (values: number[]) => {
    const out = [values[0] - (values[1] - values[0]) / 2];
    for (let k = 0; k < values.length - 1; k++) out.push((values[k] + values[k + 1]) / 2);
    out.push(values[values.length - 1] + (values[values.length - 1] - values[values.length - 2]) / 2);
    return out;
  };
  const ex = edges(xs);
  const ey = edges(ys);
  const area = {
    xMin: Math.min(ex[0], jobArea?.xMin ?? Infinity),
    xMax: Math.max(ex[ex.length - 1], jobArea?.xMax ?? -Infinity),
    yMin: Math.min(ey[0], jobArea?.yMin ?? Infinity),
    yMax: Math.max(ey[ey.length - 1], jobArea?.yMax ?? -Infinity),
  };
  const pad = Math.max(area.xMax - area.xMin, area.yMax - area.yMin) * 0.06;
  const vb = { x: area.xMin - pad, y: -(area.yMax + pad), w: area.xMax - area.xMin + 2 * pad, h: area.yMax - area.yMin + 2 * pad };
  const unit = vb.w / 600; // ~1 px at 600 px wide
  const cellW = Math.min(...xs.slice(1).map((x, k) => x - xs[k]));
  const cellH = Math.min(...ys.slice(1).map((y, k) => y - ys[k]));
  const showValues = xs.length * ys.length <= 64 && Math.min(cellW, cellH) / unit > 34;
  const hovered = hover ? { x: xs[hover.i], y: ys[hover.j], z: map.z[hover.j][hover.i] } : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <svg
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="min-h-0 w-full flex-1"
        role="img"
        aria-label={`Height map, ${xs.length} by ${ys.length} points`}
        onPointerLeave={() => setHover(null)}
      >
        {/* Cells */}
        {ys.map((_, j) =>
          xs.map((__, i) => {
            const z = map.z[j][i];
            const x0 = ex[i];
            const x1 = ex[i + 1];
            const y0 = ey[j];
            const y1 = ey[j + 1];
            const isHover = hover?.i === i && hover?.j === j;
            return (
              <rect
                key={`c${i}-${j}`}
                x={x0 + unit}
                y={-y1 + unit}
                width={Math.max(0, x1 - x0 - 2 * unit)}
                height={Math.max(0, y1 - y0 - 2 * unit)}
                rx={2 * unit}
                fill={z === null ? 'var(--color-surface-2)' : heightColor(z, limit)}
                stroke={isHover ? 'var(--color-ink)' : 'none'}
                strokeWidth={1.5 * unit}
                onPointerEnter={() => setHover({ i, j })}
                tabIndex={z === null ? -1 : 0}
                onFocus={() => setHover({ i, j })}
                onBlur={() => setHover(null)}
                aria-label={z === null ? undefined : `X ${xs[i]}, Y ${ys[j]}: ${fmt(z)} mm`}
              />
            );
          }),
        )}

        {/* Job cutting area */}
        {jobArea ? (
          <rect
            x={jobArea.xMin}
            y={-jobArea.yMax}
            width={jobArea.xMax - jobArea.xMin}
            height={jobArea.yMax - jobArea.yMin}
            fill="none"
            stroke="var(--color-ink-2)"
            strokeWidth={1.2 * unit}
            strokeDasharray={`${5 * unit} ${4 * unit}`}
            pointerEvents="none"
          />
        ) : null}

        {/* Probe points */}
        {ys.map((y, j) =>
          xs.map((x, i) => {
            const z = map.z[j][i];
            const isCurrent = current?.i === i && current?.j === j;
            return (
              <g key={`p${i}-${j}`} pointerEvents="none">
                {isCurrent ? <circle cx={x} cy={-y} r={7 * unit} fill="none" stroke="var(--color-accent)" strokeWidth={2 * unit} /> : null}
                <circle
                  cx={x}
                  cy={-y}
                  r={2.5 * unit}
                  fill={z === null ? 'none' : 'var(--color-ink)'}
                  stroke={z === null ? 'var(--color-ink-3)' : 'none'}
                  strokeWidth={1.2 * unit}
                />
                {showValues && z !== null ? (
                  <text x={x} y={-y + 14 * unit} textAnchor="middle" fontSize={11 * unit} fill="var(--color-ink)" fontFamily="var(--font-mono)">
                    {fmt(z)}
                  </text>
                ) : null}
              </g>
            );
          }),
        )}

        {/* Origin marker when visible */}
        {area.xMin <= 0 && area.xMax >= 0 && area.yMin <= 0 && area.yMax >= 0 ? (
          <g pointerEvents="none" stroke="var(--color-ink-2)" strokeWidth={1.2 * unit}>
            <line x1={-6 * unit} y1={0} x2={6 * unit} y2={0} />
            <line x1={0} y1={-6 * unit} x2={0} y2={6 * unit} />
          </g>
        ) : null}
      </svg>

      {/* Tooltip */}
      <div className="pointer-events-none absolute top-2 left-2 rounded-md border border-line bg-surface/95 px-2.5 py-1.5 text-[12px] shadow-lg" aria-live="polite">
        {hovered ? (
          <>
            <div className="font-mono text-ink">
              {hovered.z === null ? 'not probed yet' : `${fmt(hovered.z)} mm`}
            </div>
            <div className="font-mono text-ink-3">
              X {hovered.x} · Y {hovered.y}
            </div>
          </>
        ) : (
          <span className="text-ink-3">Hover a cell for its height</span>
        )}
      </div>

      {/* Legend */}
      <div className="mt-2 flex items-center gap-3 text-[11px] text-ink-3">
        <span>below Z0</span>
        <div className="flex flex-1 items-center gap-2">
          <span className="font-mono">{fmt(-limit)}</span>
          <div
            className="h-2 flex-1 rounded-full"
            style={{ background: `linear-gradient(to right, ${heightColor(-limit, limit)}, ${heightColor(0, limit)}, ${heightColor(limit, limit)})` }}
            aria-hidden
          />
          <span className="font-mono">{fmt(limit)}</span>
        </div>
        <span>above Z0</span>
        {jobArea ? (
          <span className="flex items-center gap-1">
            <svg width="18" height="8" aria-hidden>
              <line x1="0" y1="4" x2="18" y2="4" stroke="var(--color-ink-2)" strokeWidth="1.2" strokeDasharray="4 3" />
            </svg>
            job area
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The same data as a table (accessibility, exact values). Rows from high Y to low Y, like the map. */
export function HeightMapTable({ map }: { map: HeightMap }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line">
      <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
        <thead className="sticky top-0 bg-surface">
          <tr>
            <th className="px-2 py-1 text-left text-[11px] font-normal text-ink-3">Y \ X</th>
            {map.xs.map((x) => (
              <th key={x} className="px-2 py-1 text-right text-[11px] font-normal text-ink-3">
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...map.ys.keys()].reverse().map((j) => (
            <tr key={j} className="border-t border-line/60">
              <th className="px-2 py-1 text-left text-[11px] font-normal text-ink-3">{map.ys[j]}</th>
              {map.xs.map((x, i) => {
                const z = map.z[j][i];
                return (
                  <td key={x} className="px-2 py-1 text-right text-ink">
                    {z === null ? <span className="text-ink-3">—</span> : fmt(z)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
