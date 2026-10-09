// Quiet, long-lived activity indicators. A run can stay live for minutes, so these never repaint
// per frame: the dots step through a few opacity holds per cycle, and the timer writes its own
// text node once a second instead of committing through React.
import { useEffect, useRef } from 'react';

/** 42s · 1m 05s · 12m 40s */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

export function WorkingDots({ className }: { className?: string }) {
  return <span className={`awwo-working-dots${className ? ` ${className}` : ''}`} aria-hidden="true"><i /><i /><i /></span>;
}

/** Counts up from `since` (epoch ms). Purely visual; the live region beside it carries meaning. */
export function WorkingTimer({ since, className }: { since: number; className?: string }) {
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => { if (node.current) node.current.textContent = formatElapsed(Date.now() - since); };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={node} className={`awwo-working-timer${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
