// One node on the canvas, drawn with AwwO's tile styles (canvas.css + awwo-node.css) and its typed
// port handles (TilePorts). The card is a summary: identity, runtime, run state and the latest
// output. Everything editable lives in the inspector, so a drag can never edit a field by accident.
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { FileText, Play, Settings2, Trash2, Users } from 'lucide-react';
import type { CanvasNode } from '@awwo/core/canvasDoc';
import { getAgentTemplateForNode } from '@awwo/core/agentTemplates';
import type { RunNodeStatus } from '@awwo/core/runGraph';
import type { UiLocale } from './locale';
import { TilePorts, type WiringApi } from './canvas/TilePorts';
import type { ShellTranslate } from './text';

/** Presentation size of every session card; forms keep their own size. Ports anchor to this. The
 * width is AwwO's compact width, which its layout spacing (arrangeNodePositions) is built around. */
export const CARD_SIZE = { w: 260, h: 176 } as const;

export type DragPhase = 'start' | 'move' | 'end';

const STATE_CLASS: Partial<Record<RunNodeStatus['state'], string>> = {
  running: 'is-running', done: 'is-done', cached: 'is-done', failed: 'is-failed', blocked: 'is-blocked', cancelled: 'is-blocked',
};
const DOT: Partial<Record<RunNodeStatus['state'], string>> = {
  running: 'running', done: 'done', cached: 'done', failed: 'failed', blocked: 'blocked', cancelled: 'blocked', waiting: 'idle',
};

function firstLine(text: string, max = 180): string {
  const line = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`]/g, '').split(/\n+/).map(item => item.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A keyed-JSON output reads better as its first field value than as raw JSON. */
function outputSummary(text: string): string {
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const first = Object.values(value).find(item => typeof item === 'string' && item.trim());
      if (typeof first === 'string') return firstLine(first);
    }
  } catch { /* plain text output */ }
  return firstLine(text);
}

export interface NodeTileProps {
  node: CanvasNode;
  selected: boolean;
  run: RunNodeStatus | null;
  /** Text streamed by the current run, shown while the node is running. */
  live: string;
  runtimeLabel: string;
  locale: UiLocale;
  t: ShellTranslate;
  wiring: WiringApi;
  /** A run holds the document: no moving or editing until it ends. */
  locked: boolean;
  runUnavailable: string;
  scale: number;
  onSelect: (id: string, additive: boolean) => void;
  onDrag: (id: string, dx: number, dy: number, phase: DragPhase) => void;
  onConfigure: (id: string) => void;
  onRun: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenOutput: (id: string) => void;
}

export function NodeTile({ node, selected, run, live, runtimeLabel, locale, t, wiring, locked, runUnavailable, scale,
  onSelect, onDrag, onConfigure, onRun, onDelete, onOpenOutput }: NodeTileProps) {
  const drag = useRef<{ pointer: number; x: number; y: number; moved: boolean } | null>(null);
  const state = run?.state;
  const template = node.kind === 'session' ? getAgentTemplateForNode(node, locale) : undefined;
  const kind = node.kind === 'form' ? 'form' : node.agentKind === 'coding' ? 'coding' : node.agentKind === 'image' ? 'image' : 'llm';
  const glyph = node.kind === 'form' ? 'F' : (template?.tag ?? node.agentKind).slice(0, 2).toUpperCase();
  const output = node.lastOutput;
  const responsibility = node.kind === 'session' ? template?.subtitle || firstLine(node.persona) : '';

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The card owns every press inside it, or the viewport would pan (and steal pointer capture
    // from the card's own buttons).
    event.stopPropagation();
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, input, textarea, select, a, .canvas-port')) return;
    if (locked) { onSelect(node.id, event.shiftKey || event.metaKey || event.ctrlKey); return; }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (!gesture.moved) {
      if (Math.abs(event.clientX - gesture.x) + Math.abs(event.clientY - gesture.y) < 3) return;
      gesture.moved = true;
      onDrag(node.id, 0, 0, 'start');
    }
    onDrag(node.id, (event.clientX - gesture.x) / scale, (event.clientY - gesture.y) / scale, 'move');
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    drag.current = null;
    if (gesture.moved) onDrag(node.id, 0, 0, 'end');
    else onSelect(node.id, event.shiftKey || event.metaKey || event.ctrlKey);
  };

  const badge = state && state !== 'waiting'
    ? <span className={`canvas-tile-badge canvas-tile-badge--${DOT[state] === 'idle' ? 'blocked' : DOT[state]}`}>{state}</span>
    : null;

  return (
    <div
      className={`canvas-tile awwo-node awwo-card is-compact canvas-tile--${kind}${selected ? ' canvas-tile--selected' : ''}${state ? ` ${STATE_CLASS[state] ?? ''}` : ''}`}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      data-node-id={node.id}
      role="group"
      aria-label={node.title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { if (drag.current?.moved) onDrag(node.id, 0, 0, 'end'); drag.current = null; }}
      onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button, .canvas-port')) onConfigure(node.id); }}
    >
      <div className="canvas-tile-head">
        <span className={`canvas-tile-glyph canvas-tile-glyph--${kind}`} aria-hidden="true">{glyph}</span>
        <span className="canvas-tile-title" title={node.title}>{node.title || '—'}</span>
        <span className={`canvas-tile-dot canvas-tile-dot--${state ? DOT[state] : 'idle'}`} aria-hidden="true" />
        {badge}
      </div>
      <div className="canvas-tile-body">
        {node.kind === 'session' ? <>
          <p className="canvas-tile-runtime" title={runtimeLabel}>
            {runtimeLabel}
            {node.team ? <span className="awwo-card-team"><Users size={12} aria-hidden="true" />{t('team', { count: node.team.members.length })}</span> : null}
          </p>
          {state === 'running' && live
            ? <p className="awwo-card-live" aria-live="off">{live.slice(-220)}</p>
            : output
              ? <button type="button" className={`awwo-card-output${output.partial ? ' is-partial' : ''}`} onClick={() => onOpenOutput(node.id)}
                title={t('viewOutput')}>
                <FileText size={13} aria-hidden="true" />
                <span>{output.partial ? `${t('partial')} · ` : ''}{outputSummary(output.text) || t('viewOutput')}</span>
              </button>
              : <p className="awwo-node-responsibility">{run?.detail && (state === 'failed' || state === 'blocked') ? run.detail : responsibility}</p>}
        </> : <div className="canvas-form-fields">
          {node.fields.slice(0, 4).map(field => <div className="canvas-form-field" key={field.id}>
            <span className="canvas-form-field-label">{field.label}</span>
            <span className={`canvas-form-field-value${field.value ? '' : ' canvas-form-field-value--empty'}`}>{field.value || '—'}</span>
          </div>)}
          {node.fields.length > 4 ? <span className="canvas-form-field-label">{t('formFields', { count: node.fields.length })}</span> : null}
        </div>}
      </div>
      <div className="canvas-tile-actions">
        <button type="button" className="canvas-tile-action" onClick={() => onConfigure(node.id)}>
          <Settings2 size={13} aria-hidden="true" />{t('configure')}
        </button>
        <button type="button" className="canvas-tile-action" disabled={locked} onClick={() => onDelete(node.id)}>
          <Trash2 size={13} aria-hidden="true" />{t('delete')}
        </button>
        {node.kind === 'session' ? <button type="button" className="canvas-tile-action awwo-node-run" disabled={locked || Boolean(runUnavailable)}
          title={runUnavailable || undefined} onClick={() => onRun(node.id)}>
          <Play size={13} aria-hidden="true" />{t('runNode')}
        </button> : null}
      </div>
      <TilePorts node={node} wiring={wiring} />
    </div>
  );
}
