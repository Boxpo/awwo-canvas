import { useEffect, useState } from 'react';
import type { CanvasDocument, ReviewGraphPolicy } from './canvasDoc';
import { useCanvasI18n } from './i18n';
import './graph-settings.css';

interface Props {
  doc: CanvasDocument;
  selectedNodeId?: string;
  selectedEdgeId: string | null;
  disabled: boolean;
  onChange: (doc: CanvasDocument) => void;
  onAddPartner: (nodeId: string) => void;
}

export function GraphSettings({ doc, selectedNodeId, selectedEdgeId, disabled, onChange, onAddPartner }: Props) {
  const { t } = useCanvasI18n();
  const [open, setOpen] = useState(false);
  const [edgeChoice, setEdgeChoice] = useState('');
  useEffect(() => { if (selectedEdgeId) { setEdgeChoice(selectedEdgeId); setOpen(true); } }, [selectedEdgeId]);
  const sessions = doc.nodes.filter(node => node.kind === 'session');
  const policy = doc.execution;
  const reviewer = sessions.find(node => node.id === policy?.reviewerNodeId);
  const selected = sessions.find(node => node.id === selectedNodeId);
  const edge = doc.edges.find(item => item.id === edgeChoice);
  const changePolicy = (patch: Partial<ReviewGraphPolicy>) => onChange({ ...doc, execution: {
    mode: 'review', maxRounds: 3, reviewerNodeId: '', verdictFieldId: '', ...policy, ...patch,
  } });
  return <div className="awwo-graph-settings" onPointerDown={event => event.stopPropagation()}>
    <select aria-label={t('graph.mode')} value={policy ? 'review' : 'workflow'} disabled={disabled} onChange={event => {
      if (event.target.value === 'workflow') onChange({ ...doc, execution: undefined });
      else { changePolicy({}); setOpen(true); }
    }}>
      <option value="workflow">{t('graph.workflow')}</option><option value="review">{t('graph.review')}</option>
    </select>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t('graph.settings')}</button>
    {open && <section className="awwo-graph-panel" aria-label={t('graph.settings')}>
      <header><strong>{t('graph.review')}</strong><button type="button" onClick={() => setOpen(false)} aria-label={t('common.close')}>×</button></header>
      <p>{t('graph.description')}</p>
      <button type="button" className="awwo-graph-partner" disabled={disabled || !selected?.contract?.outputs.length}
        onClick={() => { if (selected) onAddPartner(selected.id); }}>{t('graph.addPartner')}</button>
      <small>{t(selected?.contract?.outputs.length ? 'graph.bindPartner' : 'graph.partnerHint')}</small>
      {policy && <>
        <div className="awwo-graph-row"><label>{t('graph.maxRounds')}<select value={policy.maxRounds} disabled={disabled}
          onChange={event => changePolicy({ maxRounds: Number(event.target.value) })}>{[1, 2, 3, 4, 5].map(value => <option key={value}>{value}</option>)}</select></label></div>
        <label>{t('graph.reviewer')}<select value={policy.reviewerNodeId} disabled={disabled} onChange={event => {
          const node = sessions.find(item => item.id === event.target.value);
          changePolicy({ reviewerNodeId: event.target.value, verdictFieldId: node?.contract?.outputs.find(field => field.type === 'boolean')?.id ?? '' });
        }}><option value="">{t('graph.choose')}</option>{sessions.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
        <label>{t('graph.verdict')}<select value={policy.verdictFieldId} disabled={disabled} onChange={event => changePolicy({ verdictFieldId: event.target.value })}>
          <option value="">{t('graph.choose')}</option>{reviewer?.contract?.outputs.filter(field => field.type === 'boolean').map(field => <option key={field.id} value={field.id}>{field.label || field.id}</option>)}
        </select></label><small>{t('graph.verdictHint')}</small>
      </>}
      <label>{t('graph.connection')}<select aria-label={t('graph.connection')} disabled={disabled} value={edge?.id ?? ''}
        onChange={event => setEdgeChoice(event.target.value)}>
        <option value="">{t('graph.choose')}</option>{doc.edges.map(item => <option key={item.id} value={item.id}>
          {doc.nodes.find(node => node.id === item.fromNode)?.title} → {doc.nodes.find(node => node.id === item.toNode)?.title} ({item.toPort.replace('in:', '')})
        </option>)}</select></label>
      {edge ? <label>{t('graph.connectionRole')}<select aria-label={t('wire.selectHint')} disabled={disabled} value={edge.kind ?? 'data'} onChange={event =>
        onChange({ ...doc, edges: doc.edges.map(item => item.id === edge.id ? { ...item, kind: event.target.value as 'data' | 'feedback' } : item) })}>
        <option value="data">{t('graph.data')}</option><option value="feedback">{t('graph.feedback')}</option>
      </select></label> : <small>{t('graph.selectConnection')}</small>}
    </section>}
  </div>;
}
