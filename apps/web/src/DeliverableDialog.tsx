// A node's latest output, field by field, exactly as downstream nodes receive it. HTML is shown in
// an opaque-origin sandbox with no capabilities (AwwO's htmlPreviewDocument + CSP), never inline.
import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Download, X } from 'lucide-react';
import type { CanvasNode } from '@awwo/core/canvasDoc';
import { htmlPreviewDocument, downloadTextDeliverable } from '@awwo/core/htmlDeliverable';
import { parseContractOutput } from '@awwo/core/nodeContracts';
import { DeliverableMarkdown } from './canvas/DeliverableMarkdown';
import type { TeamTurn } from './api';
import type { ShellTranslate } from './text';

function HtmlPreview({ value, title }: { value: string; title: string }) {
  let preview = '';
  try { preview = htmlPreviewDocument(value); } catch { /* too large: shown as source below */ }
  return preview
    ? <iframe className="awwo-html-preview" sandbox="" referrerPolicy="no-referrer" title={title} srcDoc={preview} />
    : <pre className="awwo-raw">{value}</pre>;
}

function CopyButton({ value, t }: { value: string; t: ShellTranslate }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="awwo-ghost" onClick={() => {
    void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {});
  }}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{t(copied ? 'copied' : 'copy')}</button>;
}

export function DeliverableDialog({ node, turns, t, onClose }: { node: CanvasNode; turns: TeamTurn[]; t: ShellTranslate; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const output = node.lastOutput;
  const contract = node.kind === 'session' ? node.contract : undefined;
  const parsed = contract && output ? parseContractOutput(contract, output.text) : null;
  const fields = contract && parsed ? contract.outputs.filter(field => Object.hasOwn(parsed.values, field.id)) : [];

  return <div className="awwo-modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <section className="awwo-modal awwo-deliverable-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="awwo-modal-head">
        <h2 id={titleId}>{t('deliverable', { title: node.title })}</h2>
        <button ref={closeRef} type="button" className="awwo-icon" aria-label={t('close')} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="awwo-modal-body">
        {!output ? <p className="awwo-muted">{t('noOutput')}</p> : <>
          {output.partial ? <p className="awwo-warning">{t('partial')}</p> : null}
          {parsed?.errors.length ? <div className="awwo-warning" role="alert">{t('outputInvalid')} {parsed.errors.join(' ')}</div> : null}
          {fields.map(field => {
            const value = parsed!.values[field.id];
            return <article key={field.id} className="awwo-output-field">
              <header>
                <strong>{field.label || field.id}</strong><code>{field.id} · {field.type}</code>
                <span className="awwo-spacer" />
                <CopyButton value={value} t={t} />
                {field.type === 'html' || field.type === 'markdown'
                  ? <button type="button" className="awwo-ghost" onClick={() => downloadTextDeliverable(value, `${node.title}-${field.id}`, field.type === 'html' ? 'html' : 'markdown')}>
                    <Download size={14} aria-hidden="true" />{t('download')}</button> : null}
              </header>
              {field.type === 'html' ? <HtmlPreview value={value} title={field.label || field.id} />
                : field.type === 'markdown' || field.type === 'text' ? <div className="awwo-markdown-body"><DeliverableMarkdown>{value}</DeliverableMarkdown></div>
                  : <pre className="awwo-raw">{value}</pre>}
            </article>;
          })}
          <details className="awwo-raw-details" open={!fields.length}>
            <summary>{t('rawOutput')}</summary>
            <pre className="awwo-raw">{output.text}</pre>
          </details>
        </>}
        {turns.length ? <details className="awwo-raw-details">
          <summary>{t('teamTurns')} · {turns.length}</summary>
          <ol className="awwo-turns">
            {turns.map(turn => <li key={turn.id} className={`is-${turn.status}`}>
              <p><strong>{turn.memberName}</strong> · {turn.purpose} · R{turn.round} · {turn.runtime}/{turn.model} · {turn.status}</p>
              {turn.output ? <pre className="awwo-raw">{turn.output}</pre> : turn.error ? <p className="awwo-warning">{turn.error}</p> : null}
            </li>)}
          </ol>
        </details> : null}
      </div>
    </section>
  </div>;
}
