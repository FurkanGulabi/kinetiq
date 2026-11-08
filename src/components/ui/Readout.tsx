/** Monospace, tabular coordinate readout. Shows "—" until a value is known. No animation on change. */
export function Readout({
  value,
  decimals,
  variant,
}: {
  value: number | null;
  decimals: number;
  variant: 'primary' | 'secondary';
}) {
  const text = value === null ? '—' : (Object.is(value, -0) ? 0 : value).toFixed(decimals);
  const cls =
    variant === 'primary'
      ? 'text-[34px] leading-none font-medium tracking-[-0.02em]'
      : 'text-[15px] leading-none text-ink-2';
  return (
    <span className={`font-mono tabular-nums ${cls} ${value === null ? 'text-ink-3' : variant === 'primary' ? 'text-ink' : ''}`}>
      {text}
    </span>
  );
}
