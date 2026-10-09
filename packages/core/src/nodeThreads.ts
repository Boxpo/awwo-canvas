import type { AgentBinding, NodeThread, SessionNode } from './canvasDoc';

export const DEFAULT_THREAD_ID = 'default';
let sequence = 0;

export function activeThreadId(node: SessionNode): string {
  return node.activeThreadId || DEFAULT_THREAD_ID;
}

/** Preserve the legacy store key until a node actually creates another conversation. */
export function sessionStoreKey(node: SessionNode, threadId = activeThreadId(node)): string {
  return threadId === DEFAULT_THREAD_ID ? node.id : `${node.id}::${threadId}`;
}

function snapshot(node: SessionNode, prior?: NodeThread): NodeThread {
  return {
    ...prior,
    id: activeThreadId(node),
    title: prior?.title || 'Session 1',
    issueId: node.issueId,
    preview: node.preview,
    draft: prior?.draft || '',
    createdAt: prior?.createdAt || 0,
    // A cleared active publication does not erase historical delivery evidence.
    lastOutput: prior?.lastOutput && (!node.lastOutput || prior.lastOutput.at > node.lastOutput.at)
      ? prior.lastOutput : node.lastOutput ?? null,
    outputValues: Object.fromEntries((node.contract?.outputs || []).map(field => [field.id, field.value])),
    binding: node.binding,
    agentRef: node.agentRef ?? null,
    runtime: node.runtime,
    model: node.model,
    effort: node.effort,
    persona: node.persona,
  };
}

export function getNodeThreads(node: SessionNode): NodeThread[] {
  const id = activeThreadId(node);
  const stored = node.threads || [];
  const active = snapshot(node, stored.find(thread => thread.id === id));
  return stored.some(thread => thread.id === id)
    ? stored.map(thread => thread.id === id ? active : thread)
    : [...stored, active];
}

export function activeNodeThread(node: SessionNode): NodeThread {
  return getNodeThreads(node).find(thread => thread.id === activeThreadId(node))!;
}

/** Values baked into a hired Agent at bind time. Changing them locally on an already-bound
 * thread would make the canvas describe a runtime/persona the native Agent does not have. */
export function boundAgentConfigurationChanged(current: SessionNode, next: SessionNode): boolean {
  return Boolean(current.binding) && (
    current.agentKind !== next.agentKind ||
    current.runtime !== next.runtime ||
    current.model !== next.model ||
    current.effort !== next.effort ||
    current.persona !== next.persona ||
    current.agentRef?.agentId !== next.agentRef?.agentId
  );
}

function project(node: SessionNode, threads: NodeThread[], target: NodeThread): SessionNode {
  return {
    ...node,
    threads,
    activeThreadId: target.id,
    issueId: target.issueId,
    preview: target.preview,
    binding: target.binding === undefined ? node.binding : target.binding,
    agentRef: target.agentRef ?? undefined,
    runtime: target.runtime ?? node.runtime,
    model: target.model ?? node.model,
    effort: target.effort ?? node.effort,
    persona: target.persona ?? node.persona,
    // Selecting an old conversation never republishes a historical result downstream.
    lastOutput: null,
    ...(node.contract ? { contract: { ...node.contract,
      outputs: node.contract.outputs.map(field => ({ ...field, value: target.outputValues?.[field.id] || '' })),
    } } : {}),
  };
}

export function createNodeThread(node: SessionNode): SessionNode {
  const threads = getNodeThreads(node);
  sequence += 1;
  const thread: NodeThread = {
    id: `thread-${Date.now().toString(36)}-${sequence.toString(36)}`,
    title: `Session ${threads.length + 1}`,
    issueId: null,
    preview: '',
    draft: '',
    createdAt: Date.now(),
    binding: node.binding,
    agentRef: node.agentRef ?? null,
    runtime: node.runtime, model: node.model, effort: node.effort, persona: node.persona,
    lastOutput: null,
    outputValues: {},
  };
  return project(node, [...threads, thread], thread);
}

export function selectNodeThread(node: SessionNode, threadId: string): SessionNode {
  if (threadId === activeThreadId(node)) return node;
  const threads = getNodeThreads(node);
  const target = threads.find(thread => thread.id === threadId);
  return target ? project(node, threads, target) : node;
}

export function updateNodeDraft(node: SessionNode, draft: string, threadId = activeThreadId(node)): SessionNode {
  const threads = getNodeThreads(node);
  const target = threads.find(thread => thread.id === threadId);
  if (!target || target.draft === draft) return node;
  return { ...node, threads: threads.map(thread => thread.id === threadId ? { ...thread, draft } : thread) };
}

export function updateThreadIssueId(node: SessionNode, threadId: string, issueId: string): SessionNode {
  const threads = getNodeThreads(node);
  const target = threads.find(thread => thread.id === threadId);
  if (!target || target.issueId === issueId) return node;
  return { ...node, threads: threads.map(thread => thread.id === threadId ? { ...thread, issueId } : thread),
    ...(threadId === activeThreadId(node) ? { issueId } : {}),
  };
}

export function updateThreadPreview(node: SessionNode, threadId: string, preview: string): SessionNode {
  const threads = getNodeThreads(node);
  const target = threads.find(thread => thread.id === threadId);
  if (!target || target.preview === preview) return node;
  return { ...node, threads: threads.map(thread => thread.id === threadId ? { ...thread, preview } : thread),
    ...(threadId === activeThreadId(node) ? { preview } : {}),
  };
}

/** An old issue stays attached to its original binding; a changed binding starts a new thread. */
export function rebindNodeThread(node: SessionNode, binding: AgentBinding | null): SessionNode {
  if (node.binding?.companyId === binding?.companyId && node.binding?.agentId === binding?.agentId) return node;
  const saved = getNodeThreads(node);
  // Connecting a never-bound draft completes that same local Session; it creates no extra row.
  if (!node.binding && !node.issueId) {
    return { ...node, binding, threads: saved.map(thread => thread.id === activeThreadId(node) ? { ...thread, binding } : thread) };
  }
  const next = createNodeThread({ ...node, threads: saved });
  return { ...next, binding,
    threads: next.threads!.map(thread => thread.id === next.activeThreadId ? { ...thread, binding } : thread),
  };
}

/** Undo layout/config edits without reverting server-issued identities or locally typed drafts. */
export function preserveThreadRuntime(target: SessionNode, live: SessionNode): SessionNode {
  const current = new Map(getNodeThreads(live).map(thread => [thread.id, thread]));
  const threads = getNodeThreads(target).map(thread => {
    const fresh = current.get(thread.id);
    if (!fresh) return thread;
    const newlyBound = !thread.binding && Boolean(fresh.binding);
    return { ...thread, issueId: fresh.issueId, preview: fresh.preview, draft: fresh.draft,
      binding: fresh.binding === undefined ? thread.binding : fresh.binding,
      lastOutput: fresh.lastOutput ?? thread.lastOutput,
      outputValues: fresh.outputValues ?? thread.outputValues,
      ...(newlyBound ? { runtime: fresh.runtime, model: fresh.model, effort: fresh.effort, persona: fresh.persona, agentRef: fresh.agentRef ?? null } : {}),
    };
  });
  // A conversation created since an old undo snapshot must stay reachable.
  for (const thread of current.values()) if (!threads.some(item => item.id === thread.id)) threads.push(thread);
  const active = threads.find(thread => thread.id === activeThreadId(target))!;
  const newlyBound = !target.binding && Boolean(active.binding);
  return { ...target, threads, issueId: active.issueId, preview: active.preview,
    binding: active.binding === undefined ? target.binding : active.binding,
    ...(newlyBound ? { runtime: active.runtime ?? target.runtime, model: active.model ?? target.model,
      effort: active.effort ?? target.effort, persona: active.persona ?? target.persona, agentRef: active.agentRef ?? undefined } : {}),
  };
}
