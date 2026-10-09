// The node inspector (right dock). It edits one node: identity, which runtime/model/effort it runs
// on (read live from the hot-plug registry), its persona, its input values, its output contract,
// its optional multi-agent team — and holds a free conversation with it.
import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { CanvasEdge, CanvasNode, FormNode, SessionNode } from '@awwo/core/canvasDoc';
import type { ContractField, ContractFieldType } from '@awwo/core/nodeContracts';
import type { RuntimeView } from '@awwo/core/protocol';
import { ContractFields } from './canvas/ContractFields';
import { DeliverableMarkdown } from './canvas/DeliverableMarkdown';
import { NodeTeamEditor } from './canvas/NodeTeamEditor';
import { TileComposer } from './canvas/TileComposer';
import { prepareNodeConversation } from './canvas/nodeConversation';
import { WorkingDots } from './canvas/WorkingIndicator';
import { api } from './api';
import type { ShellTranslate } from './text';
import './canvas/awwo-node.css';

export interface ChatTurn { role: 'user' | 'assistant'; content: string; status?: 'streaming' | 'failed' | 'cancelled' }

const OUTPUT_TYPES: ContractFieldType[] = ['text', 'markdown', 'html', 'number', 'boolean', 'file'];

interface InspectorProps {
  node: CanvasNode;
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  runtimes: RuntimeView[];
  defaultRuntime: string;
  locked: boolean;
  t: ShellTranslate;
  /** `key` coalesces one continuous edit into one undo step. */
  onChange: (node: CanvasNode, key: string) => void;
  onClose: () => void;
  chat: ChatTurn[];
  chatBusy: boolean;
  onChat: (text: string) => void;
  onStopChat: () => void;
  onClearChat: () => void;
}

export function Inspector(props: InspectorProps) {
  const { node, t, onClose } = props;
  return (
    <aside className="canvas-inspector awwo-inspector" aria-label={t('inspectorTitle')} onPointerDown={event => event.stopPropagation()}>
      <header className="canvas-inspector-head">
        <span className="canvas-inspector-title">{t('inspectorTitle')}</span>
        <button type="button" className="canvas-inspector-close" aria-label={t('close')} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="canvas-inspector-body">
        <label className="canvas-inspector-label" htmlFor="awwo-node-title">{t('title')}</label>
        <input id="awwo-node-title" className="canvas-inspector-input" value={node.title} disabled={props.locked} maxLength={120}
          onChange={event => props.onChange({ ...node, title: event.target.value }, `title:${node.id}`)} />
        {node.kind === 'session' ? <SessionSettings {...props} node={node} /> : <FormSettings {...props} node={node} />}
      </div>
    </aside>
  );
}

function SessionSettings({ node, nodes, edges, runtimes, defaultRuntime, locked, t, onChange, chat, chatBusy, onChat, onStopChat, onClearChat }: InspectorProps & { node: SessionNode }) {
  const [draft, setDraft] = useState('');
  const effectiveRuntime = node.runtime || defaultRuntime;
  const runtime = runtimes.find(item => item.id === effectiveRuntime);
  const model = runtime?.models.find(item => item.id === (node.model || runtime.defaultModel));
  const ready = runtimes.filter(item => item.status === 'ready');
  const conversation = prepareNodeConversation(node, nodes, edges.filter(edge => edge.kind !== 'feedback'));
  const change = (patch: Partial<SessionNode>, key: string) => onChange({ ...node, ...patch }, `${key}:${node.id}`);
  const contract = node.contract;

  return <>
    <span className="canvas-inspector-label">{t('runtime')}</span>
    <div className="canvas-inspector-runtime">
      <select className="canvas-inspector-input" aria-label={t('runtime')} value={node.runtime} disabled={locked}
        onChange={event => change({ runtime: event.target.value, model: '', effort: '' }, 'runtime')}>
        <option value="">{t('defaultRuntime')}{defaultRuntime ? ` (${defaultRuntime})` : ''}</option>
        {runtimes.map(item => <option key={item.id} value={item.id}>
          {item.status === 'ready' ? `${item.label} · ${item.id}` : t('unavailableRuntime', { id: item.id })}
        </option>)}
        {node.runtime && !runtimes.some(item => item.id === node.runtime)
          ? <option value={node.runtime}>{t('unavailableRuntime', { id: node.runtime })}</option> : null}
      </select>
      <select className="canvas-inspector-input" aria-label={t('model')} value={node.model} disabled={locked || !runtime}
        onChange={event => change({ model: event.target.value, effort: '' }, 'model')}>
        <option value="">{t('defaultModel')}{runtime?.defaultModel ? ` (${runtime.defaultModel})` : ''}</option>
        {runtime?.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        {node.model && runtime && !runtime.models.some(item => item.id === node.model)
          ? <option value={node.model}>{t('unavailableRuntime', { id: node.model })}</option> : null}
      </select>
      {model && model.reasoningEfforts.length > 0 ? <select className="canvas-inspector-input" aria-label={t('effort')} value={node.effort} disabled={locked}
        onChange={event => change({ effort: event.target.value }, 'effort')}>
        <option value="">{t('effortDefault')}{model.defaultReasoningEffort ? ` (${model.defaultReasoningEffort})` : ''}</option>
        {model.reasoningEfforts.map(level => <option key={level} value={level}>{level}</option>)}
      </select> : null}
    </div>

    <label className="canvas-inspector-label" htmlFor="awwo-node-persona">{t('persona')}</label>
    <textarea id="awwo-node-persona" className="canvas-inspector-persona" value={node.persona} disabled={locked} rows={6}
      onChange={event => change({ persona: event.target.value }, 'persona')} />

    {contract ? <>
      <span className="canvas-inspector-label">{t('inputs')}</span>
      <ContractFields valuesFirst fields={contract.inputs} resolvedFields={conversation.inputs} sources={conversation.sources}
        recorded={conversation.recorded} label={t('inputs')} readOnly={locked}
        onChange={inputs => change({ contract: { ...contract, inputs } }, 'inputs')} />
      <span className="canvas-inspector-label">{t('outputs')}</span>
      <OutputSchema fields={contract.outputs} locked={locked} t={t}
        onChange={outputs => change({ contract: { ...contract, outputs } }, 'outputs')} />
    </> : null}

    <NodeTeamEditor node={{ ...node, runtime: effectiveRuntime }} available={ready.length > 0} disabled={locked}
      runtimes={ready.map(item => item.id)} runtimeTools={Object.fromEntries(ready.map(item => [item.id, item.tools]))}
      readJson={api.readJson} onChange={team => change({ team }, 'team')} />

    <span className="canvas-inspector-label">{t('chat')}</span>
    <p className="canvas-inspector-hint">{t('chatHint')}</p>
    <div className="awwo-inspector-chat">
      {chat.length === 0 ? <p className="canvas-inspector-hint">{t('chatEmpty')}</p> : chat.map((turn, index) =>
        <div key={index} className={`awwo-chat-turn awwo-chat-turn--${turn.role}${turn.status === 'failed' ? ' is-failed' : ''}`}>
          {turn.role === 'assistant' ? <DeliverableMarkdown>{turn.content || ' '}</DeliverableMarkdown> : <p>{turn.content}</p>}
          {turn.status === 'streaming' ? <WorkingDots /> : null}
        </div>)}
    </div>
    <div className="awwo-inspector-composer">
      <TileComposer streaming={chatBusy} draft={draft} onDraftChange={setDraft} sendUnavailableReason={ready.length ? undefined : t('noRuntime')}
        onSend={text => { onChat(text); setDraft(''); }} />
    </div>
    <div className="awwo-inspector-row">
      {chatBusy ? <button type="button" className="canvas-inspector-add-field" onClick={onStopChat}>{t('taskStop')}</button> : null}
      {chat.length > 0 && !chatBusy ? <button type="button" className="canvas-inspector-add-field" onClick={onClearChat}>{t('chatClear')}</button> : null}
    </div>
  </>;
}

/** The output contract's structure: what this node must hand downstream. Values come from runs. */
function OutputSchema({ fields, locked, t, onChange }: { fields: ContractField[]; locked: boolean; t: ShellTranslate; onChange: (fields: ContractField[]) => void }) {
  const patch = (id: string, update: Partial<ContractField>) => onChange(fields.map(field => field.id === id ? { ...field, ...update } : field));
  const add = () => {
    let index = fields.length + 1;
    while (fields.some(field => field.id === `output_${index}`)) index += 1;
    onChange([...fields, { id: `output_${index}`, label: `Output ${index}`, type: 'markdown', required: false, value: '' }]);
  };
  return <div className="awwo-contract-fields">
    {fields.map(field => <div className="awwo-contract-field" key={field.id}>
      <div className="awwo-field-header">
        <input className="awwo-field-name" aria-label={t('formFieldLabel')} value={field.label} disabled={locked}
          onChange={event => patch(field.id, { label: event.target.value })} />
        <select aria-label={field.label} value={field.type} disabled={locked} onChange={event => patch(field.id, { type: event.target.value as ContractFieldType })}>
          {OUTPUT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
        <button type="button" className="awwo-field-remove" aria-label={t('removeField')} disabled={locked}
          onClick={() => onChange(fields.filter(item => item.id !== field.id))}><Trash2 size={15} aria-hidden="true" /></button>
      </div>
      <label className="awwo-field-required"><input type="checkbox" checked={field.required} disabled={locked}
        onChange={event => patch(field.id, { required: event.target.checked })} />required · <code>{field.id}</code></label>
    </div>)}
    <button type="button" className="awwo-field-add" disabled={locked} onClick={add}><Plus size={15} aria-hidden="true" />{t('addField')}</button>
  </div>;
}

function FormSettings({ node, locked, t, onChange }: InspectorProps & { node: FormNode }) {
  const update = (fields: FormNode['fields']) => onChange({ ...node, fields }, `fields:${node.id}`);
  const add = () => {
    let index = node.fields.length + 1;
    while (node.fields.some(field => field.id === `f${index}`)) index += 1;
    update([...node.fields, { id: `f${index}`, label: `Field ${index}`, value: '' }]);
  };
  return <>
    {node.fields.map(field => <div key={field.id} className="awwo-form-field">
      <div className="canvas-inspector-field-row">
        <input className="canvas-inspector-input canvas-inspector-field-label" aria-label={t('formFieldLabel')} value={field.label} disabled={locked}
          onChange={event => update(node.fields.map(item => item.id === field.id ? { ...item, label: event.target.value } : item))} />
        <button type="button" className="canvas-inspector-field-remove" aria-label={t('removeField')} disabled={locked}
          onClick={() => update(node.fields.filter(item => item.id !== field.id))}>×</button>
      </div>
      <textarea className="canvas-inspector-persona" aria-label={`${field.label} · ${t('formFieldValue')}`} value={field.value} disabled={locked} rows={3}
        onChange={event => update(node.fields.map(item => item.id === field.id ? { ...item, value: event.target.value } : item))} />
    </div>)}
    <button type="button" className="canvas-inspector-add-field" disabled={locked} onClick={add}>{t('addField')}</button>
  </>;
}
