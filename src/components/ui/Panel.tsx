/** Flat panel region: quiet uppercase title row + body. No card, no shadow (ARCHITECTURE §9.2). */
export function Panel({
  title,
  actions,
  children,
  className = '',
  flush = false,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Edge-to-edge body (no padding), e.g. for a canvas. */
  flush?: boolean;
}) {
  return (
    <section aria-label={title} className={`flex min-h-0 flex-col bg-surface ${className}`}>
      <header className="flex h-10 shrink-0 items-center justify-between px-4">
        <h2 className="panel-label">{title}</h2>
        {actions ? <div className="flex items-center gap-2 text-[12px] text-ink-3">{actions}</div> : null}
      </header>
      <div className={`flex min-h-0 flex-1 flex-col ${flush ? '' : 'px-4 pb-4'}`}>{children}</div>
    </section>
  );
}
