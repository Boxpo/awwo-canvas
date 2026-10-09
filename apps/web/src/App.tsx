// AwwO Canvas, open-source edition: one infinite canvas of agent nodes and their typed wires, the
// node inspector, graph runs on the orchestrator, and the canvas assistant that plans or executes.
// The document is the single source of truth; every edit is one undo step (a drag is one gesture),
// and run results are written into every history snapshot rather than added as edits.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createAgentTemplate, createDevelopmentTemplate } from '@awwo/core/agentTemplates';
import { createFormNode, loadDocumentWithStatus, sanitizeDocument, saveDocument, type CanvasDocument, type CanvasNode } from '@awwo/core/canvasDoc';
import { invalidateOutputs } from '@awwo/core/invalidateOutputs';
import { edgeId, type DataType, type PortRef } from '@awwo/core/ports';
import type { RuntimeView } from '@awwo/core/protocol';
import { addReviewPartner } from '@awwo/core/reviewPartner';
import { boundsOfBoxes, fitBounds, type Size, type ViewportState } from '@awwo/core/viewport';
import { CanvasAssistant } from './canvas/CanvasAssistant';
import { CanvasViewport } from './canvas/CanvasViewport';
import { GraphSettings } from './canvas/GraphSettings';
import { LocaleProvider } from './canvas/i18n';
import { Marquee, useMarquee } from './canvas/Marquee';
import { Minimap } from './canvas/Minimap';
import { useWiring } from './canvas/TilePorts';
import { useCanvasKeys } from './canvas/useCanvasKeys';
import { WirePlane } from './canvas/WirePlane';
import { api } from './api';
import { AddMenu, RunBar, TaskCard, TopBar, type AddChoice } from './Chrome';
import { DeliverableDialog } from './DeliverableDialog';
import { exampleDocument, type ExampleId } from './examples';
import { commit, createHistory, mapAll, redo, undo, type History } from './history';
import { Inspector } from './Inspector';
import type { UiLocale } from './locale';
import { CARD_SIZE, NodeTile, type DragPhase } from './NodeTile';
import { RuntimesPanel } from './RuntimesPanel';
import { shellText } from './text';
import { useAssistant } from './useAssistant';
import { settleOutputs, useGraphRun } from './useGraphRun';
import { useNodeChat } from './useNodeChat';
import './canvas/ios-theme.css';
import './canvas/canvas.css';
import './canvas/awwo-node.css';
import './app.css';

const LOCALE_KEY = 'awwo.locale';
const TOPBAR = 56;
const DOCK = 400;

function initialLocale(): UiLocale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* fall back to the browser language */ }
  return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language) ? 'zh' : 'en';
}

export function App() {
  const [locale, setLocale] = useState(initialLocale);
  const toggle = () => setLocale(current => {
    const next = current === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem(LOCALE_KEY, next); } catch { /* this page only */ }
    return next;
  });
  return <LocaleProvider locale={locale}><Workspace locale={locale} onToggleLocale={toggle} /></LocaleProvider>;
}

function Workspace({ locale, onToggleLocale }: { locale: UiLocale; onToggleLocale: () => void }) {
  const t = useMemo(() => shellText(locale), [locale]);
  const [loaded] = useState(() => loadDocumentWithStatus());
  const [history, setHistory] = useState<History<CanvasDocument>>(() => createHistory(loaded.doc));
  const doc = history.present;
  const docRef = useRef(doc);
  docRef.current = doc;
  const [notice, setNotice] = useState(loaded.status === 'corrupt' ? t('corrupt') : '');
  const [view, setView] = useState<ViewportState>(() => loaded.doc.view ?? { x: 80, y: 120, scale: 1 });
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const fitted = useRef(Boolean(loaded.doc.view));
  const [fitRequest, setFitRequest] = useState(0);
  const [selection, setSelection] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const [outputId, setOutputId] = useState<string | null>(null);
  const [runtimesOpen, setRuntimesOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [menu, setMenu] = useState<{ world: { x: number; y: number }; client: { x: number; y: number } } | null>(null);
  const [registry, setRegistry] = useState<{ online: boolean; items: RuntimeView[]; defaultRuntime: string }>({ online: false, items: [], defaultRuntime: '' });
  const rootRef = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<{ seq: number; at: Map<string, { x: number; y: number }> } | null>(null);
  const dragSeq = useRef(0);

  /** One edit: a new snapshot with downstream outputs that no longer hold cleared. */
  const change = useCallback((next: (current: CanvasDocument) => CanvasDocument, key: string | null = null) => {
    setHistory(current => {
      const value = next(current.present);
      return value === current.present ? current : commit(current, invalidateOutputs(current.present, { ...value, updatedAt: Date.now() }), key);
    });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { if (!saveDocument({ ...doc, view })) setNotice(t('corrupt')); }, 250);
    return () => clearTimeout(timer);
  }, [doc, view, t]);

  // The hot-plug registry, read live: workers come and go while the canvas is open.
  const refreshRuntimes = useCallback(async () => {
    try {
      const { items, defaultRuntime } = await api.runtimes();
      setRegistry({ online: true, items, defaultRuntime });
    } catch {
      setRegistry(previous => ({ ...previous, online: false }));
    }
  }, []);
  useEffect(() => {
    void refreshRuntimes();
    const timer = setInterval(() => void refreshRuntimes(), 5000);
    return () => clearInterval(timer);
  }, [refreshRuntimes]);
  const ready = registry.items.filter(item => item.status === 'ready');
  const unavailable = !registry.online ? t('runtimesOffline') : ready.length ? '' : t('noRuntime');

  const graph = useGraphRun({
    getDocument: () => docRef.current,
    onSettle: record => setHistory(current => mapAll(current, value => settleOutputs(value, record))),
  });
  const locked = graph.running;
  const runNodes = graph.run?.nodes ?? {};
  const chat = useNodeChat(t);

  // Session cards share one presentation size; ports and wires anchor to what is drawn.
  const nodes = useMemo(() => doc.nodes.map((node): CanvasNode => node.kind === 'session' ? { ...node, w: CARD_SIZE.w, h: CARD_SIZE.h } : node), [doc.nodes]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const fitAll = useCallback(() => {
    if (!size.w || !size.h) return;
    const width = size.w - (inspectorId ? 360 : assistantOpen && nodesRef.current.length ? DOCK : 0);
    if (!nodesRef.current.length) { setView({ x: width / 2 - CARD_SIZE.w / 2, y: TOPBAR + 120, scale: 1 }); return; }
    setView(fitBounds(boundsOfBoxes(nodesRef.current), { w: width, h: size.h }, undefined, { x: 100, top: TOPBAR + 72, bottom: 48 }));
  }, [size, inspectorId, assistantOpen]);
  useEffect(() => { if (!fitted.current && size.w && size.h) { fitted.current = true; fitAll(); } }, [size, fitAll]);
  useEffect(() => { if (fitRequest) fitAll(); }, [fitRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const assistant = useAssistant({
    locale,
    getDocument: () => docRef.current,
    applyDocument: (next, label, added) => {
      setHistory(current => commit(current, next, label));
      setSelection(added);
      setFitRequest(count => count + 1);
    },
    undoDocument: () => setHistory(undo),
    historyKey: history.key,
    unavailableReason: unavailable,
    graphRunning: graph.running,
    execution: { runtime: '', model: '' },
  });

  const replaceDocument = (next: CanvasDocument) => {
    if (locked) return;
    setHistory(current => commit(current, { ...next, view: null, updatedAt: Date.now() }));
    setSelection([]);
    setInspectorId(null);
    setOutputId(null);
    setFitRequest(count => count + 1);
  };
  const importDocument = (text: string) => {
    try {
      const parsed = JSON.parse(text) as { nodes?: unknown };
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes)) throw new Error('not a document');
      const next = sanitizeDocument(parsed);
      if (parsed.nodes.length && !next.nodes.length) throw new Error('no readable node');
      replaceDocument(next);
      setNotice('');
    } catch { setNotice(t('importFailed')); }
  };
  const exportDocument = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...docRef.current, view: null }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `awwo-canvas-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const addNode = (choice: AddChoice, at: { x: number; y: number }) => {
    if (locked) return;
    if (choice === 'team') {
      const team = createDevelopmentTemplate(at, locale);
      change(current => ({ ...current, nodes: [...current.nodes, ...team.nodes], edges: [...current.edges, ...team.edges] }));
      setSelection(team.nodes.map(node => node.id));
      return;
    }
    const form = createFormNode(at);
    const node: CanvasNode = choice !== 'form' ? createAgentTemplate(choice, at, locale) : locale === 'en'
      ? { ...form, title: t('addForm'), fields: [{ id: 'f1', label: 'Goal', value: '' }, { id: 'f2', label: 'Constraints', value: '' }] } : form;
    change(current => ({ ...current, nodes: [...current.nodes, node] }));
    setSelection([node.id]);
  };
  const deleteNodes = (ids: string[]) => {
    if (locked || !ids.length) return;
    const gone = new Set(ids);
    change(current => {
      const next: CanvasDocument = { ...current, nodes: current.nodes.filter(node => !gone.has(node.id)),
        edges: current.edges.filter(edge => !gone.has(edge.fromNode) && !gone.has(edge.toNode)) };
      // A review policy whose reviewer is gone cannot run; the graph goes back to a plain workflow.
      if (current.execution && gone.has(current.execution.reviewerNodeId)) delete next.execution;
      return next;
    });
    setSelection(current => current.filter(id => !gone.has(id)));
    if (inspectorId && gone.has(inspectorId)) setInspectorId(null);
    for (const id of ids) chat.stop(id);
  };
  const disconnect = (id: string) => {
    if (locked) return;
    change(current => ({ ...current, edges: current.edges.filter(edge => edge.id !== id) }));
    setSelectedEdgeId(null);
  };

  const onSelect = (id: string, additive: boolean) => {
    setSelectedEdgeId(null);
    setSelection(current => additive ? (current.includes(id) ? current.filter(item => item !== id) : [...current, id]) : [id]);
  };
  // A drag moves the whole selection when it starts on a selected node, and is ONE undo step.
  const onDrag = (id: string, dx: number, dy: number, phase: DragPhase) => {
    if (phase === 'start') {
      const ids = selection.includes(id) ? selection : [id];
      if (!selection.includes(id)) setSelection([id]);
      dragOrigin.current = { seq: ++dragSeq.current, at: new Map(docRef.current.nodes.filter(node => ids.includes(node.id)).map(node => [node.id, { x: node.x, y: node.y }])) };
      return;
    }
    const origin = dragOrigin.current;
    if (phase === 'end' || !origin) { dragOrigin.current = null; return; }
    change(current => ({ ...current, nodes: current.nodes.map(node => {
      const start = origin.at.get(node.id);
      return start ? { ...node, x: Math.round(start.x + dx), y: Math.round(start.y + dy) } : node;
    }) }), `move:${origin.seq}`);
  };

  const wiring = useWiring({ nodes, edges: doc.edges, rootRef, view,
    onConnect: locked ? undefined : (from: PortRef, to: PortRef, dataType: DataType) => change(current => ({ ...current,
      edges: [...current.edges, { id: edgeId(from, to), fromNode: from.nodeId, fromPort: from.portId, toNode: to.nodeId, toPort: to.portId, dataType }] })) });
  const marquee = useMarquee({ nodes, rootRef, view,
    onSelect: (ids, additive) => setSelection(current => additive ? [...new Set([...current, ...ids])] : ids) });
  const onBackgroundPointerDown = (event: ReactPointerEvent) => {
    wiring.clearPending();
    setMenu(null);
    const claimed = marquee.onBackgroundPointerDown(event);
    if (!claimed) { setSelection([]); setSelectedEdgeId(null); }
    return claimed;
  };

  useCanvasKeys({
    onUndo: () => { if (!locked) setHistory(undo); },
    onRedo: () => { if (!locked) setHistory(redo); },
    onDeleteSelection: () => { if (selectedEdgeId) disconnect(selectedEdgeId); else deleteNodes(selection); },
    onFitAll: fitAll,
    onEscape: () => { setMenu(null); setOutputId(null); if (inspectorId) setInspectorId(null); else setSelection([]); },
  });

  const runtimeLabel = (node: CanvasNode) => {
    if (node.kind !== 'session') return '';
    const id = node.runtime || registry.defaultRuntime;
    const runtime = registry.items.find(item => item.id === id);
    const modelId = node.model || runtime?.defaultModel || '';
    const model = runtime?.models.find(item => item.id === modelId)?.label ?? modelId;
    return id ? `${runtime?.label ?? id}${model ? ` · ${model}` : ''}` : t('runtimesNone');
  };
  const defaultRuntime = registry.items.find(item => item.id === registry.defaultRuntime);
  const sessionSelection = selection.filter(id => doc.nodes.some(node => node.id === id && node.kind === 'session'));
  const inspected = doc.nodes.find(node => node.id === inspectorId);
  const outputNode = doc.nodes.find(node => node.id === outputId && node.lastOutput);
  const welcome = assistantOpen && !inspectorId && doc.nodes.length === 0 && assistant.messages.length === 0 && !assistant.pending;
  const dockOpen = assistantOpen && !inspectorId && !welcome;

  return <div className="awwo-workspace">
    <div className={`canvas-root awwo-app${dockOpen ? ' has-dock' : ''}${inspected ? ' has-inspector' : ''}${wiring.wireDrag || wiring.pendingPort ? ' is-wiring' : ''}`} ref={rootRef}>
      <CanvasViewport view={view} onViewChange={setView} onResize={setSize} onBackgroundPointerDown={onBackgroundPointerDown}
        onBackgroundContextMenu={(world, client) => { if (!locked) setMenu({ world, client }); }}
        onBackgroundDoubleClick={world => { if (!locked) setMenu({ world, client: { x: world.x * view.scale + view.x, y: world.y * view.scale + view.y } }); }}>
        <WirePlane nodes={nodes} edges={doc.edges} preview={wiring.wireDrag} onDisconnect={locked ? undefined : edge => disconnect(edge.id)}
          runs={runNodes} running={graph.running} round={graph.run?.round ?? 1} scale={view.scale} selectedEdgeId={selectedEdgeId ?? undefined}
          onSelectEdge={id => { setSelectedEdgeId(id); setSelection([]); }} />
        {nodes.map(node => <NodeTile key={node.id} node={node} selected={selection.includes(node.id)} run={runNodes[node.id] ?? null}
          live={graph.run?.live[node.id] ?? ''} runtimeLabel={runtimeLabel(node)} locale={locale} t={t} wiring={wiring} locked={locked}
          runUnavailable={unavailable} scale={view.scale} onSelect={onSelect} onDrag={onDrag}
          onConfigure={id => { setInspectorId(id); setSelection([id]); }} onRun={id => void graph.start([id])}
          onDelete={id => deleteNodes([id])} onOpenOutput={setOutputId} />)}
        <Marquee rect={marquee.rect} />
      </CanvasViewport>

      <TopBar t={t} status={{ online: registry.online, ready: ready.length }} assistantOpen={assistantOpen} locked={locked}
        onToggleAssistant={() => setAssistantOpen(open => !open)} onToggleLocale={onToggleLocale} onOpenRuntimes={() => setRuntimesOpen(true)}
        onExample={(id: ExampleId) => replaceDocument(exampleDocument(id, locale))} onImport={importDocument} onExport={exportDocument}
        onClear={() => replaceDocument({ ...docRef.current, nodes: [], edges: [], execution: undefined })} />
      <div className="awwo-toolrow">
        <RunBar t={t} run={graph.run} running={graph.running} stopping={graph.stopping} error={graph.error} selected={sessionSelection.length}
          unavailable={unavailable} empty={!doc.nodes.some(node => node.kind === 'session')} onRun={scoped => void graph.start(scoped ? sessionSelection : undefined)}
          onStop={() => void graph.stop()} onDismiss={() => { graph.dismiss(); graph.setError(''); }} />
        {doc.nodes.length ? <GraphSettings doc={doc} selectedNodeId={selection[0]} selectedEdgeId={selectedEdgeId} disabled={locked}
          onChange={next => change(() => next)}
          onAddPartner={nodeId => { try { change(current => addReviewPartner(current, nodeId, locale).doc); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }} /> : null}
      </div>
      {notice ? <div className="awwo-notice" role="alert"><span>{notice}</span><button type="button" className="awwo-icon-only" aria-label={t('close')} onClick={() => setNotice('')}>×</button></div> : null}
      {doc.nodes.length === 0 && !welcome ? <p className="awwo-empty-hint">{t('emptyHint')}</p> : null}
      {doc.nodes.length ? <Minimap boxes={nodes} view={view} size={size} style={{ top: TOPBAR + 16, right: inspected ? 376 : dockOpen ? DOCK + 16 : 16 }}
        onCenter={(wx, wy) => setView(current => ({ ...current, x: size.w / 2 - wx * current.scale, y: size.h / 2 - wy * current.scale }))} /> : null}

      {welcome || dockOpen ? <div className={welcome ? 'awwo-welcome' : 'awwo-assistant-dock'}>
        <CanvasAssistant mode={welcome ? 'welcome' : 'panel'} messages={assistant.messages} draft={assistant.draft} onDraftChange={assistant.setDraft}
          busy={assistant.busy} error={assistant.error} onSend={assistant.send} onCancel={assistant.cancel} onClose={() => setAssistantOpen(false)}
          onUndo={assistant.undo} canUndo={assistant.canUndo} progress={assistant.progress} expectedSeconds={assistant.expectedSeconds}
          unified={{ pending: assistant.pending, switchRoute: assistant.switchRoute,
            renderTask: taskId => <TaskCard task={assistant.taskView(taskId)} t={t} onStop={() => assistant.stopTask(taskId)} />,
            settings: defaultRuntime ? <p className="awwo-assistant-settings">{t('defaultRuntimeInfo', { runtime: defaultRuntime.label, model: defaultRuntime.defaultModel })}</p> : null }} />
      </div> : null}

      {inspected ? <Inspector node={inspected} nodes={doc.nodes} edges={doc.edges} runtimes={registry.items} defaultRuntime={registry.defaultRuntime}
        locked={locked} t={t} onClose={() => setInspectorId(null)}
        onChange={(node, key) => change(current => ({ ...current, nodes: current.nodes.map(item => item.id === node.id ? node : item) }), key)}
        chat={chat.turns(inspected.id)} chatBusy={chat.busy(inspected.id)} onStopChat={() => chat.stop(inspected.id)} onClearChat={() => chat.clear(inspected.id)}
        onChat={text => { if (inspected.kind === 'session') chat.send(inspected, text); }} /> : null}
      {menu ? <AddMenu t={t} locale={locale} at={menu.client} onAdd={choice => addNode(choice, menu.world)} onClose={() => setMenu(null)} /> : null}
      {outputNode ? <DeliverableDialog node={outputNode} turns={graph.run?.turns[outputNode.id] ?? []} t={t} onClose={() => setOutputId(null)} /> : null}
      {runtimesOpen ? <RuntimesPanel runtimes={registry.items} defaultRuntime={registry.defaultRuntime} t={t} onClose={() => setRuntimesOpen(false)}
        onChanged={() => void refreshRuntimes()} /> : null}
    </div>
  </div>;
}
