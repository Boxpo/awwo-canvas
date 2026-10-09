// The shell around the canvas: the top bar, the run bar, the add-node menu and the assistant's task
// card. Presentation only; App owns every piece of state these read.
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ChevronDown, Languages, MessageSquare, Play, Plug, Square, X } from 'lucide-react';
import { getAgentTemplates, type AgentTemplateId } from '@awwo/core/agentTemplates';
import { DeliverableMarkdown } from './canvas/DeliverableMarkdown';
import { WorkingDots } from './canvas/WorkingIndicator';
import type { ExampleId } from './examples';
import type { UiLocale } from './locale';
import type { ShellTranslate } from './text';
import type { RunState } from './useGraphRun';
import type { AssistantTask } from './useAssistant';

/** Close a popover on a press anywhere outside it, or on Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) closeRef.current(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return ref;
}

interface TopBarProps {
  t: ShellTranslate;
  status: { online: boolean; ready: number };
  assistantOpen: boolean;
  locked: boolean;
  onToggleAssistant: () => void;
  onToggleLocale: () => void;
  onOpenRuntimes: () => void;
  onExample: (id: ExampleId) => void;
  onImport: (text: string) => void;
  onExport: () => void;
  onClear: () => void;
}

export function TopBar({ t, status, assistantOpen, locked, onToggleAssistant, onToggleLocale, onOpenRuntimes, onExample, onImport, onExport, onClear }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useDismiss(menuOpen, () => setMenuOpen(false));
  const file = useRef<HTMLInputElement>(null);
  const pick = (action: () => void) => () => { setMenuOpen(false); action(); };
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (chosen) void chosen.text().then(onImport);
  };
  const runtimeLabel = !status.online ? t('runtimesOffline') : status.ready ? t('runtimesReady', { count: status.ready }) : t('runtimesNone');
  return <header className="awwo-topbar" onPointerDown={event => event.stopPropagation()}>
    <div className="awwo-brand"><img src="/favicon.svg" alt="" width={22} height={22} /><strong>{t('brand')}</strong><span>{t('edition')}</span></div>
    <div className="awwo-menu" ref={menu}>
      <button type="button" className="awwo-chip" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>
        {t('canvasMenu')}<ChevronDown size={14} aria-hidden="true" />
      </button>
      {menuOpen ? <div className="awwo-menu-list" role="menu">
        <button type="button" role="menuitem" disabled={locked} onClick={pick(() => onExample('workflow'))}>{t('exampleWorkflow')}</button>
        <button type="button" role="menuitem" disabled={locked} onClick={pick(() => onExample('review'))}>{t('exampleReview')}</button>
        <button type="button" role="menuitem" disabled={locked} onClick={pick(() => onExample('team'))}>{t('exampleTeam')}</button>
        <hr />
        <button type="button" role="menuitem" disabled={locked} onClick={pick(() => file.current?.click())}>{t('importJson')}</button>
        <button type="button" role="menuitem" onClick={pick(onExport)}>{t('exportJson')}</button>
        <hr />
        <button type="button" role="menuitem" className="is-danger" disabled={locked} onClick={pick(onClear)}>{t('newCanvas')}</button>
      </div> : null}
      <input ref={file} type="file" accept="application/json,.json" hidden onChange={onFile} />
    </div>
    <span className="awwo-topbar-spacer" />
    <button type="button" className={`awwo-chip awwo-runtime-chip${status.online && status.ready ? ' is-ready' : ' is-down'}`} onClick={onOpenRuntimes}>
      <Plug size={14} aria-hidden="true" />{runtimeLabel}
    </button>
    <button type="button" className={`awwo-chip${assistantOpen ? ' is-active' : ''}`} aria-pressed={assistantOpen} onClick={onToggleAssistant}>
      <MessageSquare size={14} aria-hidden="true" />{t('assistantToggle')}
    </button>
    <button type="button" className="awwo-chip" onClick={onToggleLocale}><Languages size={14} aria-hidden="true" />{t('language')}</button>
  </header>;
}

function runLine(t: ShellTranslate, run: RunState): string {
  const states = Object.values(run.nodes);
  const done = states.filter(status => status.state === 'done').length;
  const summary = run.summary;
  const cached = summary?.cached ? ` · ${t('cached', { count: summary.cached })}` : '';
  switch (run.status) {
    case 'queued': return t('runQueued');
    case 'running': return `${t('runRunning', { done, total: states.length })}${run.mode === 'review' ? ` · ${t('runRound', { round: run.round })}` : ''}`;
    case 'cancelled': return t('runCancelled');
    case 'completed':
      if (summary?.review?.outcome === 'approved') return `${t('runApproved', { rounds: summary.review.rounds })}${cached}`;
      if (summary?.review?.outcome === 'exhausted') return `${t('runExhausted', { rounds: summary.review.rounds })}${cached}`;
      return `${t('runCompleted', { done: summary?.done ?? done })}${cached}`;
    case 'failed':
      return `${t('runFailed', { done: summary?.done ?? done, failed: summary?.failed ?? 0, blocked: summary?.blocked ?? 0 })}${cached}`;
  }
}

interface RunBarProps {
  t: ShellTranslate;
  run: RunState | null;
  running: boolean;
  stopping: boolean;
  error: string;
  /** Selected session nodes: a run can be scoped to them. */
  selected: number;
  unavailable: string;
  empty: boolean;
  onRun: (scoped: boolean) => void;
  onStop: () => void;
  onDismiss: () => void;
}

export function RunBar({ t, run, running, stopping, error, selected, unavailable, empty, onRun, onStop, onDismiss }: RunBarProps) {
  const failed = run?.status === 'failed' || Boolean(error);
  const note = error || (run ? [runLine(t, run), run.error].filter(Boolean).join(' · ') : unavailable);
  return <div className="awwo-runbar" onPointerDown={event => event.stopPropagation()}>
    {running
      ? <button type="button" className="canvas-run-btn canvas-run-btn--stop" disabled={stopping} onClick={onStop}>
        <Square size={13} aria-hidden="true" /> {t(stopping ? 'stopping' : 'stop')}
      </button>
      : <>
        <button type="button" className="canvas-run-btn" disabled={empty || Boolean(unavailable)} title={unavailable || undefined} onClick={() => onRun(false)}>
          <Play size={13} aria-hidden="true" /> {t('run')}
        </button>
        {selected > 0 ? <button type="button" className="canvas-run-btn canvas-run-btn--stop" disabled={Boolean(unavailable)} onClick={() => onRun(true)}>
          {t('runSelection', { count: selected })}
        </button> : null}
      </>}
    {note ? <span className={`canvas-run-note${failed ? ' canvas-run-note--err' : ''}`} role="status" title={note}>{note}</span> : null}
    {run && !running ? <button type="button" className="awwo-icon-only" aria-label={t('close')} onClick={onDismiss}><X size={14} aria-hidden="true" /></button> : null}
  </div>;
}

export type AddChoice = AgentTemplateId | 'form' | 'team';

export function AddMenu({ t, locale, at, onAdd, onClose }: { t: ShellTranslate; locale: UiLocale; at: { x: number; y: number };
  onAdd: (choice: AddChoice) => void; onClose: () => void }) {
  const ref = useDismiss(true, onClose);
  const left = Math.min(at.x, window.innerWidth - 220);
  const top = Math.min(at.y, window.innerHeight - 380);
  const add = (choice: AddChoice) => () => { onAdd(choice); onClose(); };
  return <div ref={ref} className="canvas-add-menu" role="menu" aria-label={t('addNode')} style={{ left, top, position: 'fixed' }}
    onPointerDown={event => event.stopPropagation()}>
    <span className="canvas-add-menu-title">{t('addNode')}</span>
    {getAgentTemplates(locale).map(template => <button type="button" role="menuitem" key={template.id} className="canvas-add-menu-item"
      title={template.subtitle} onClick={add(template.id)}>
      <span className="awwo-menu-glyph" aria-hidden="true">{template.tag.slice(0, 2).toUpperCase()}</span>{template.title}
    </button>)}
    <button type="button" role="menuitem" className="canvas-add-menu-item" onClick={add('form')}>
      <span className="awwo-menu-glyph" aria-hidden="true">F</span>{t('addForm')}
    </button>
    <button type="button" role="menuitem" className="canvas-add-menu-item" onClick={add('team')}>
      <span className="awwo-menu-glyph" aria-hidden="true">5</span>{t('addTeamTemplate')}
    </button>
  </div>;
}

export function TaskCard({ task, t, onStop }: { task: AssistantTask; t: ShellTranslate; onStop: () => void }) {
  const meta = [task.runtime, task.model].filter(Boolean).join(' · ');
  const state = task.status === 'running' ? t('taskRunning') : task.status === 'cancelled' ? t('taskStopped') : '';
  return <div className={`awwo-task-card is-${task.status}`}>
    {meta || state ? <p className="awwo-task-meta">{meta}{meta && state ? ' · ' : ''}{state}</p> : null}
    {task.text ? <DeliverableMarkdown>{task.text}</DeliverableMarkdown> : task.status === 'running' ? <WorkingDots /> : null}
    {task.error ? <p className="awwo-task-error" role="alert">{t('taskFailed', { error: task.error })}</p> : null}
    {task.status === 'running' ? <button type="button" className="awwo-ghost" onClick={onStop}><Square size={12} aria-hidden="true" />{t('taskStop')}</button> : null}
  </div>;
}
