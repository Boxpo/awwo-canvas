import { canvasStorage } from './storage';
// The persisted canvas document.
//
// Product model (owner, 2026-08): THE NODE IS THE AGENT SESSION. Each tile on the infinite
// canvas holds a live agent conversation rendered inside it; a tile's input comes from an
// upstream tile's output or a user-authored form; each tile freely picks its agent kind
// (LLM / coding / image), runtime, model, effort and persona. This module is the document
// behind that surface plus its fail-soft persistence — localStorage-backed, the canvas is
// the only writer.
//
// Honesty invariants this file is responsible for (do not weaken):
//  - A bind attempt whose outcome was UNKNOWN persists on the node (`bindAttempt`), so a
//    blind retry after a reload cannot silently hire a duplicate agent.
//  - Runtime / model / effort are never back-filled. '' means "not chosen"; the picker fills
//    it from the server contract, and nothing here invents a default.
//  - A corrupt payload is copied to CANVAS_BACKUP_KEY BEFORE anything can overwrite the
//    primary key, and `loadDocumentWithStatus` reports 'corrupt' distinctly from 'empty':
//    "couldn't read what was there" must never look like "there was nothing".
//  - First run seeds NOTHING. An empty canvas is empty.

import type { DataType } from './ports';
import { reconcileEdges } from './ports';
import type { ViewportState } from './viewport';
import { normalizeContract, type NodeContract } from './nodeContracts';
import type { AgentTemplateId } from './agentTemplates';
import { sanitizeNodeTeam, type NodeTeam } from './nodeTeam';

export type AgentKind = 'llm' | 'coding' | 'image' | 'video';

/** An image or video node's parameter choices. An absent key takes the model's default on the server. */
export type MediaParamValue = string | number | boolean;
export type MediaParams = Record<string, MediaParamValue>;

/** The real agent standing behind a session tile, once bound (hired on the control plane).
 *  null = the tile is a local draft — configurable, but it cannot chat or run yet. */
export interface AgentBinding {
  companyId: string;
  agentId: string;
  agentName: string;
}

interface CanvasNodeBase {
  id: string;
  /** World-space top-left + size (the canvas's unified coordinate system). */
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

export interface WorkspaceAgentReference {
  source: 'workspace';
  agentId: string;
}

export interface SessionNode extends CanvasNodeBase {
  kind: 'session';
  agentKind: AgentKind;
  /** Governed runtime selection (RuntimePicker contract). '' = not chosen (never back-filled). */
  runtime: string;
  model: string;
  effort: string;
  /** Persona / system prompt draft. Synced to the bound agent's instructions bundle on bind. */
  persona: string;
  /** Optional collaboration plan; the primary binding remains the legacy conversation owner. */
  team?: NodeTeam;
  /** Select an existing Agent in the current workspace. The server resolves its configuration. */
  agentRef?: WorkspaceAgentReference;
  binding: AgentBinding | null;
  /** A bind attempt whose outcome was UNKNOWN (request sent, response lost). Persisted so the
   *  tile keeps warning across reloads — a blind retry could hire a duplicate agent.
   *  Cleared only by a confirmed bind. */
  bindAttempt: 'unknown' | null;
  /** THIS tile's own conversation thread (per-node, not per-agent): two tiles bound to the
   *  same hired agent still hold two independent conversations. null = no thread yet. */
  issueId: string | null;
  /** Last transcript line, persisted so the glance-LOD tile reads correctly right after a
   *  reload, before the session store has fetched any history. */
  preview: string;
  /** Local conversation identity; the server issueId is minted only after a real send. */
  activeThreadId?: string;
  threads?: NodeThread[];
  /** Pairs the visible in-node drawer with its persisted expanded node width. */
  deliverablesOpen?: boolean;
  /** Explicit role guidance; the node's saved contract remains its source of truth. */
  templateId?: AgentTemplateId;
  templateVersion?: number;
  /** The last thing this node produced — see NodeOutput. */
  lastOutput?: NodeOutput | null;
  /** Absent on legacy sessions, which retain their context/result ports. */
  contract?: NodeContract;
  /** Preserve unknown versions unchanged; editors must validate before interpreting. */
  taskFrame?: unknown;
  /** Image and video nodes only: choices for the model's closed parameters. */
  mediaParams?: MediaParams;
}

/** Conversation metadata and drafts persist locally; transcripts are restored from the server. */
export interface NodeThread {
  id: string;
  title: string;
  issueId: string | null;
  preview: string;
  draft: string;
  createdAt: number;
  lastOutput?: NodeOutput | null;
  outputValues?: Record<string, string>;
  /** Keep old conversations addressed to their original agent after a rebind. */
  binding?: AgentBinding | null;
  runtime?: string;
  model?: string;
  effort?: string;
  persona?: string;
  /** null explicitly marks a custom/legacy thread, rather than inheriting a later selection. */
  agentRef?: WorkspaceAgentReference | null;
}

/**
 * What a node last PRODUCED — the exact text a downstream node would receive.
 *
 * This has to live on the node, not in the run. Outputs used to exist only inside one runGraph
 * call, in a Map that vanished the moment the run returned, and were rendered nowhere: the canvas
 * threw away everything it made. That is what forced every run to be the whole graph from
 * scratch, since no upstream result survived to be reused, and it is why the iteration loop the
 * product exists for — look at what came out, adjust one node, run just that node — was not
 * expressible at all.
 */
export interface NodeOutput {
  text: string;
  /** When it was captured (wall clock). */
  at: number;
  /**
   * Where it came from. Honesty matters here: a result the operator hand-picked out of a chat
   * must never be presented as something the engine produced, and a partial capture off a FAILED
   * run must never look like a completed one. `case` is a published production case's recorded
   * delivery, copied in with its canvas: it is real, but it did not run in this workspace.
   */
  source: 'run' | 'manual' | 'case';
  /** True when the run that produced this did not succeed — the text is evidence, not a result. */
  partial?: boolean;
  /** For a case recording, the model that produced it (the copy may run another one). */
  model?: string;
}

/** "qwen3.8-27b-p6 · 2026-10-03": the model that made a case recording and the day it ran (UTC). */
export function caseRunLabel(output: NodeOutput): string {
  const day = output.at > 0 && output.at < 8.64e15 ? new Date(output.at).toISOString().slice(0, 10) : '';
  return [output.model, day].filter(Boolean).join(' · ');
}

export interface FormField {
  id: string;
  label: string;
  value: string;
}

export interface FormNode extends CanvasNodeBase {
  kind: 'form';
  fields: FormField[];
  /** A form's output is derived from its fields, but it is still captured on the run so the
   *  timeline can show exactly what was sent, not a re-derivation of what would be sent now. */
  lastOutput?: NodeOutput | null;
}

export type CanvasNode = SessionNode | FormNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
  dataType: DataType;
  /** Feedback is read only from the previous completed review round. */
  kind?: 'data' | 'feedback';
}

export interface ReviewGraphPolicy {
  mode: 'review';
  maxRounds: number;
  reviewerNodeId: string;
  verdictFieldId: string;
}

/** A saved viewport the operator can jump back to (number-key slots 1–9). */
export interface Waypoint {
  slot: number;
  view: ViewportState;
  label?: string;
}

export interface CanvasDocument {
  version: 2;
  updatedAt: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  waypoints: Waypoint[];
  /** Last viewport, restored on reload. null = never saved one; the surface fits instead. */
  view: ViewportState | null;
  /** Absent on legacy documents, which keep their single-pass workflow semantics. */
  execution?: ReviewGraphPolicy;
}

export const CANVAS_STORAGE_KEY = 'awwo.canvas.v2';
/** Latest unreadable payload, preserved BEFORE anything can overwrite the primary key. */
export const CANVAS_BACKUP_KEY = 'awwo.canvas.v2.corrupt';
/** The previous canvas's document key, read once for the one-way migration (see below). */
export const LEGACY_WORKFLOW_STORAGE_KEY = 'awwo.studio.workflow.v1';

export const AGENT_KIND_META: Record<AgentKind, { label: string; glyph: string }> = {
  llm: { label: 'LLM', glyph: 'L' },
  coding: { label: '编码', glyph: 'C' },
  image: { label: '图像', glyph: 'I' },
  video: { label: '视频', glyph: 'V' },
};

/** Default tile sizes. Sessions are taller because they render a live transcript. */
export const SESSION_NODE_SIZE = { w: 340, h: 260 } as const;
export const FORM_NODE_SIZE = { w: 300, h: 200 } as const;

const AGENT_KINDS: ReadonlyArray<AgentKind> = ['llm', 'coding', 'image', 'video'];
const AGENT_TEMPLATE_IDS: ReadonlyArray<AgentTemplateId> = ['general', 'frontend', 'backend', 'data', 'users', 'materials', 'review'];
/** Waypoint slots are the number-row keys; anything outside is clamped into range. */
export const WAYPOINT_MIN_SLOT = 1;
export const WAYPOINT_MAX_SLOT = 9;

let nodeSeq = 0;
function mintId(): string {
  nodeSeq += 1;
  return `cv-${Date.now().toString(36)}-${nodeSeq.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function createSessionNode(kind: AgentKind, pos: { x: number; y: number }): SessionNode {
  return {
    id: mintId(),
    kind: 'session',
    x: pos.x,
    y: pos.y,
    w: SESSION_NODE_SIZE.w,
    h: SESSION_NODE_SIZE.h,
    title: `${AGENT_KIND_META[kind].label} 会话`,
    agentKind: kind,
    // Fail-closed: nothing is chosen until the operator picks from the server contract.
    runtime: '',
    model: '',
    effort: '',
    persona: '',
    binding: null,
    bindAttempt: null,
    issueId: null,
    preview: '',
  };
}

export function createFormNode(pos: { x: number; y: number }): FormNode {
  return {
    id: mintId(),
    kind: 'form',
    x: pos.x,
    y: pos.y,
    w: FORM_NODE_SIZE.w,
    h: FORM_NODE_SIZE.h,
    title: '需求表单',
    fields: [
      { id: 'f1', label: '目标', value: '' },
      { id: 'f2', label: '约束', value: '' },
    ],
  };
}

export function emptyDocument(): CanvasDocument {
  return { version: 2, updatedAt: Date.now(), nodes: [], edges: [], waypoints: [], view: null };
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * A stored output, or null.
 *
 * An entry with no text is dropped rather than kept as an empty result: "this node produced
 * nothing" and "this node has not produced anything yet" are different claims, and only the
 * second one is true of a document that never carried the field.
 */
function sanitizeOutput(raw: unknown): NodeOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === 'string' ? r.text : '';
  if (!text) return null;
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0;
  const source = r.source === 'manual' || r.source === 'case' ? r.source : 'run';
  return {
    text,
    at,
    source,
    ...(r.partial === true ? { partial: true } : {}),
    ...(source === 'case' && typeof r.model === 'string' && r.model && r.model.length <= 200 ? { model: r.model } : {}),
  };
}

function sanitizeAgentReference(raw: unknown): WorkspaceAgentReference | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || value.source !== 'workspace' || typeof value.agentId !== 'string'
    || !value.agentId.trim() || value.agentId !== value.agentId.trim() || value.agentId.length > 200) return undefined;
  return { source: 'workspace', agentId: value.agentId };
}

function sanitizeThreads(raw: unknown): NodeThread[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const threads = new Map<string, NodeThread>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    const values = r.outputValues && typeof r.outputValues === 'object' && !Array.isArray(r.outputValues)
      ? Object.fromEntries(Object.entries(r.outputValues).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined;
    let binding: AgentBinding | null | undefined;
    if (r.binding === null) binding = null;
    else if (r.binding && typeof r.binding === 'object') {
      const b = r.binding as Record<string, unknown>;
      if (str(b.companyId) && str(b.agentId)) binding = { companyId: str(b.companyId), agentId: str(b.agentId), agentName: str(b.agentName, 'agent') };
    }
    threads.set(id, {
      id, title: str(r.title, '会话'), issueId: str(r.issueId) || null,
      preview: str(r.preview), draft: str(r.draft), createdAt: num(r.createdAt),
      lastOutput: sanitizeOutput(r.lastOutput),
      ...(values ? { outputValues: values } : {}),
      ...(binding !== undefined ? { binding } : {}),
      agentRef: sanitizeAgentReference(r.agentRef) ?? null,
      ...Object.fromEntries(['runtime', 'model', 'effort', 'persona'].filter(key => typeof r[key] === 'string').map(key => [key, r[key]])),
    });
  }
  return [...threads.values()];
}

function sanitizeNode(raw: unknown): CanvasNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;

  if (r.kind === 'form') {
    const fields = Array.isArray(r.fields)
      ? r.fields
          .map((f): FormField | null => {
            if (!f || typeof f !== 'object') return null;
            const fr = f as Record<string, unknown>;
            const fid = str(fr.id);
            return fid ? { id: fid, label: str(fr.label), value: str(fr.value) } : null;
          })
          .filter((f): f is FormField => f !== null)
      : [];
    return {
      id,
      kind: 'form',
      x: num(r.x),
      y: num(r.y),
      w: num(r.w, FORM_NODE_SIZE.w),
      h: num(r.h, FORM_NODE_SIZE.h),
      title: str(r.title, '需求表单'),
      fields,
      lastOutput: sanitizeOutput(r.lastOutput),
    };
  }

  if (r.kind === 'session') {
    const agentRef = sanitizeAgentReference(r.agentRef);
    if (r.agentRef != null && !agentRef) return null;
    if (Array.isArray(r.threads) && r.threads.some(thread => thread && typeof thread === 'object'
      && (thread as Record<string, unknown>).agentRef != null
      && !sanitizeAgentReference((thread as Record<string, unknown>).agentRef))) return null;
    const contract = normalizeContract(r.contract);
    const team = r.team == null ? undefined : sanitizeNodeTeam(r.team);
    const threads = sanitizeThreads(r.threads);
    const templateId = AGENT_TEMPLATE_IDS.includes(r.templateId as AgentTemplateId) ? r.templateId as AgentTemplateId : undefined;
    // A declared but unreadable schema must not silently become a legacy session with
    // unrestricted context/result ports. The loader preserves the raw document for recovery.
    if (r.contract != null && !contract) return null;
    // A malformed team must never become a single-agent run. The loader preserves the
    // original payload and reports corrupt status when this node cannot be recovered.
    if (r.team != null && !team) return null;
    // An unrecognised agent kind is coerced rather than dropped: the tile's persona, binding
    // and thread are the operator's real work, and losing them to a typo'd enum would be worse
    // than showing it as an LLM tile they can switch back.
    const agentKind = AGENT_KINDS.includes(r.agentKind as AgentKind) ? (r.agentKind as AgentKind) : 'llm';
    const mediaParams = sanitizeMediaParams(r.mediaParams);
    let binding: AgentBinding | null = null;
    if (r.binding && typeof r.binding === 'object') {
      const b = r.binding as Record<string, unknown>;
      const companyId = str(b.companyId);
      const agentId = str(b.agentId);
      // A half-written binding names no real agent — keeping it would let the tile claim it is
      // bound when nothing can be addressed.
      if (companyId && agentId) binding = { companyId, agentId, agentName: str(b.agentName, 'agent') };
    }
    return {
      id,
      kind: 'session',
      x: num(r.x),
      y: num(r.y),
      w: num(r.w, SESSION_NODE_SIZE.w),
      h: num(r.h, SESSION_NODE_SIZE.h),
      title: str(r.title, '未命名会话'),
      agentKind,
      runtime: str(r.runtime),
      model: str(r.model),
      effort: str(r.effort),
      persona: str(r.persona),
      ...(team ? { team } : {}),
      ...(agentRef ? { agentRef } : {}),
      binding,
      bindAttempt: r.bindAttempt === 'unknown' ? 'unknown' : null,
      issueId: typeof r.issueId === 'string' && r.issueId ? r.issueId : null,
      preview: str(r.preview),
      ...(templateId ? { templateId,
        ...(typeof r.templateVersion === 'number' && Number.isInteger(r.templateVersion) && r.templateVersion > 0
          ? { templateVersion: r.templateVersion } : {}),
      } : {}),
      ...(typeof r.deliverablesOpen === 'boolean' ? { deliverablesOpen: r.deliverablesOpen } : {}),
      ...(threads ? { threads } : {}),
      ...(typeof r.activeThreadId === 'string' && threads?.some(thread => thread.id === r.activeThreadId)
        ? { activeThreadId: r.activeThreadId } : {}),
      lastOutput: sanitizeOutput(r.lastOutput),
      ...(contract ? { contract } : {}),
      ...(Object.hasOwn(r, 'taskFrame') ? { taskFrame: r.taskFrame } : {}),
      ...(mediaParams ? { mediaParams } : {}),
    };
  }

  return null;
}

const MEDIA_PARAM_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

/** Keeps well-formed parameter choices; the server validates them against the model at each run. */
function sanitizeMediaParams(raw: unknown): MediaParams | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const params: MediaParams = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>).slice(0, 16)) {
    if (!MEDIA_PARAM_NAME.test(name)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 8000)) params[name] = value;
  }
  return Object.keys(params).length ? params : undefined;
}

function sanitizeEdge(raw: unknown, nodeIds: ReadonlySet<string>): CanvasEdge | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const dataType: DataType = r.dataType === 'image' || r.dataType === 'video' || r.dataType === 'number' || r.dataType === 'boolean' || r.dataType === 'file'
    ? r.dataType : 'text';
  const edge: CanvasEdge = {
    id: str(r.id),
    fromNode: str(r.fromNode),
    fromPort: str(r.fromPort),
    toNode: str(r.toNode),
    toPort: str(r.toPort),
    dataType,
    ...(r.kind === 'feedback' || r.kind === 'data' ? { kind: r.kind } : {}),
  };
  if (!edge.id || !edge.fromNode || !edge.toNode || !edge.fromPort || !edge.toPort) return null;
  // An edge whose endpoint node no longer exists is dropped — a dangling wire must never
  // resurrect against a different node that later reuses that id.
  if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) return null;
  return edge;
}

function sanitizeView(raw: unknown): ViewportState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.scale)) return null;
  const scale = r.scale as number;
  if (scale <= 0) return null;
  return { x: r.x as number, y: r.y as number, scale };
}

function sanitizeWaypoints(raw: unknown): Waypoint[] {
  if (!Array.isArray(raw)) return [];
  // A slot holds exactly one viewport; if a corrupt payload carries two for the same slot the
  // later one wins rather than leaving the jump ambiguous.
  const bySlot = new Map<number, Waypoint>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const view = sanitizeView(w.view);
    if (!view) continue;
    const slot = Math.min(WAYPOINT_MAX_SLOT, Math.max(WAYPOINT_MIN_SLOT, Math.round(num(w.slot, WAYPOINT_MIN_SLOT))));
    const label = typeof w.label === 'string' ? w.label : undefined;
    bySlot.set(slot, label === undefined ? { slot, view } : { slot, view, label });
  }
  return Array.from(bySlot.values()).sort((a, b) => a.slot - b.slot);
}

/**
 * Fail-soft normalisation of anything claiming to be a canvas document. Malformed nodes are
 * dropped, a bad agentKind is coerced, half-written bindings are discarded, dangling edges are
 * removed, and the surviving edges are re-validated against the nodes' REAL ports (so a wire
 * whose port vanished with an agentKind switch cannot outlive it, and no stored dataType is
 * ever trusted over the source port's own type).
 */
export function sanitizeDocument(raw: unknown): CanvasDocument {
  if (!raw || typeof raw !== 'object') return emptyDocument();
  const r = raw as Record<string, unknown>;
  const nodes = Array.isArray(r.nodes)
    ? r.nodes.map(sanitizeNode).filter((n): n is CanvasNode => n !== null)
    : [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = Array.isArray(r.edges)
    ? r.edges.map((e) => sanitizeEdge(e, nodeIds)).filter((e): e is CanvasEdge => e !== null)
    : [];
  // A declared but damaged execution policy stays visibly invalid and cannot fall back to
  // an unrestricted single pass. Preflight explains the missing/invalid policy fields.
  const execution = r.execution != null
    ? typeof r.execution === 'object' && !Array.isArray(r.execution) ? r.execution as Record<string, unknown> : {}
    : null;
  return {
    version: 2,
    updatedAt: num(r.updatedAt, Date.now()),
    nodes,
    edges: reconcileEdges(nodes, edges),
    waypoints: sanitizeWaypoints(r.waypoints),
    view: sanitizeView(r.view),
    ...(execution ? { execution: {
      mode: 'review' as const,
      maxRounds: execution.mode === 'review' ? num(execution.maxRounds, 0) : 0,
      reviewerNodeId: str(execution.reviewerNodeId),
      verdictFieldId: str(execution.verdictFieldId),
    } } : {}),
  };
}

export type CanvasLoadStatus = 'ok' | 'empty' | 'corrupt';

function preserveCorrupt(raw: string, err: unknown, source: string): void {
  try {
    canvasStorage().setItem(CANVAS_BACKUP_KEY, raw);
  } catch {
    /* backup best-effort — the log below still names the loss */
  }
  // eslint-disable-next-line no-console
  console.error(
    `[canvas] ${source} unreadable — original payload preserved at localStorage["${CANVAS_BACKUP_KEY}"]`,
    err,
  );
}

// ---- legacy migration ---------------------------------------------------------------------
// The previous canvas persisted the same graph under a different shape and key. Real operator
// bindings in there point at genuinely hired agents; abandoning that key would orphan them
// (the agents keep existing on the control plane with nothing on the canvas addressing them).
// So: one-way, read-only conversion. The legacy key is never written to and never deleted —
// if this migration were ever wrong, the original is still on disk.

function legacyNodeToRaw(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'form') {
    return { ...r, kind: 'form', w: FORM_NODE_SIZE.w, h: FORM_NODE_SIZE.h };
  }
  if (r.kind === 'agent') {
    return {
      ...r,
      kind: 'session',
      // legacy `agentType` → `agentKind`; an unknown value is coerced by sanitizeNode.
      agentKind: r.agentType,
      w: SESSION_NODE_SIZE.w,
      h: SESSION_NODE_SIZE.h,
      // The legacy family had no per-node thread and no persisted preview: an empty thread is
      // the truth, not a placeholder we could invent.
      issueId: null,
      preview: '',
    };
  }
  return null;
}

function legacyToDocumentRaw(legacy: unknown): Record<string, unknown> {
  const r = (legacy && typeof legacy === 'object' ? legacy : {}) as Record<string, unknown>;
  const nodes = Array.isArray(r.nodes)
    ? r.nodes.map(legacyNodeToRaw).filter((n): n is Record<string, unknown> => n !== null)
    : [];
  return {
    version: 2,
    updatedAt: r.updatedAt,
    nodes,
    edges: Array.isArray(r.edges) ? r.edges : [],
    waypoints: [],
    view: null,
  };
}

/**
 * Convert the previous canvas's document when this canvas has none of its own.
 * Returns null when there is nothing to migrate (either key already holds a v2 document, or
 * no legacy document exists) — a first run with neither key is an EMPTY canvas, never seeded.
 * Throws nothing: an unreadable legacy payload is preserved to the backup key and reported as
 * null (the caller then shows an empty canvas, which is honest — we could not read it).
 */
export function migrateFromLegacy(): CanvasDocument | null {
  let current: string | null = null;
  let legacy: string | null = null;
  try {
    current = canvasStorage().getItem(CANVAS_STORAGE_KEY);
    legacy = canvasStorage().getItem(LEGACY_WORKFLOW_STORAGE_KEY);
  } catch {
    return null;
  }
  if (current) return null;
  if (!legacy) return null;
  try {
    return sanitizeDocument(legacyToDocumentRaw(JSON.parse(legacy)));
  } catch (err) {
    preserveCorrupt(legacy, err, 'legacy workflow document');
    return null;
  }
}

/**
 * Load with an honest status. On an unreadable payload the raw bytes are copied to
 * CANVAS_BACKUP_KEY and the failure is logged — the surface auto-saves on mount, which would
 * otherwise silently overwrite the only (possibly hand-recoverable) copy of the operator's
 * graph with an empty document.
 *
 * When this canvas has no document of its own, a legacy document is migrated in and reported
 * as 'ok': we DID read a real graph. 'empty' is reserved for "there was genuinely nothing".
 */
/** null when `raw` looks like a document we wrote; otherwise a short reason it does not. */
function describeNonDocument(raw: unknown): string | null {
  if (raw === null) return 'null';
  if (typeof raw !== 'object') return `a ${typeof raw}`;
  if (Array.isArray(raw)) return 'an array';
  if (!Array.isArray((raw as { nodes?: unknown }).nodes)) return 'no nodes array';
  return null;
}

export function loadDocumentWithStatus({ readOnly = false }: { readOnly?: boolean } = {}): { doc: CanvasDocument; status: CanvasLoadStatus } {
  let raw: string | null = null;
  try {
    raw = canvasStorage().getItem(CANVAS_STORAGE_KEY);
  } catch {
    // Storage itself unreadable (privacy mode / policy): nothing to back up.
    return { doc: emptyDocument(), status: 'corrupt' };
  }
  if (!raw) {
    const migrated = readOnly ? null : migrateFromLegacy();
    if (migrated) return { doc: migrated, status: 'ok' };
    return { doc: emptyDocument(), status: 'empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!readOnly) preserveCorrupt(raw, err, 'canvas document');
    return { doc: emptyDocument(), status: 'corrupt' };
  }

  // Parsing is only half of "readable". A payload can be valid JSON and still be nothing we can
  // make a document out of — a bare string/number, or an object whose every node fails
  // sanitisation because it was written in a different shape. `sanitizeDocument` is deliberately
  // lenient and would hand back an EMPTY document for all of those, which the surface then
  // persists over the original on mount: the user's graph would be gone with no trace and no
  // message. So total loss is treated exactly like a parse failure.
  // Every payload this module writes is a plain object carrying a `nodes` ARRAY. Anything else
  // at this key — a bare scalar, an array, an object from some other writer — is not our
  // document, and must not be laundered into "you have an empty canvas".
  const shape = describeNonDocument(parsed);
  if (shape) {
    if (!readOnly) preserveCorrupt(raw, new Error(`not a canvas document (${shape})`), 'canvas document');
    return { doc: emptyDocument(), status: 'corrupt' };
  }
  const declaredNodes = ((parsed as { nodes: unknown[] }).nodes).length;
  const doc = sanitizeDocument(parsed);
  if (declaredNodes > 0 && doc.nodes.length === 0) {
    if (!readOnly) preserveCorrupt(raw, new Error(`all ${declaredNodes} stored node(s) failed sanitisation`), 'canvas document');
    return { doc: emptyDocument(), status: 'corrupt' };
  }
  // PARTIAL loss is still loss: the surviving nodes are kept (dropping them too would turn a
  // small defect into a total wipe), but the original payload is preserved so the dropped ones
  // remain recoverable rather than vanishing silently.
  if (declaredNodes > doc.nodes.length) {
    if (!readOnly) preserveCorrupt(
      raw,
      new Error(`${declaredNodes - doc.nodes.length} of ${declaredNodes} stored node(s) failed sanitisation`),
      'canvas document',
    );
    const invalidTeam = (parsed as { nodes: unknown[] }).nodes.some(rawNode => {
      if (!rawNode || typeof rawNode !== 'object') return false;
      const candidate = rawNode as Record<string, unknown>;
      return candidate.kind === 'session' && candidate.team != null && !sanitizeNodeTeam(candidate.team);
    });
    if (invalidTeam) return { doc, status: 'corrupt' };
  }
  return { doc, status: 'ok' };
}

export function loadDocument(): CanvasDocument {
  return loadDocumentWithStatus().doc;
}

export function saveDocument(doc: CanvasDocument): boolean {
  try {
    const storage = canvasStorage();
    const serialized = JSON.stringify(doc);
    // A redundant write also broadcasts a cache-change event to the cloud autosaver.
    if (storage.getItem(CANVAS_STORAGE_KEY) !== serialized) storage.setItem(CANVAS_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}
