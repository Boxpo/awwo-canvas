// A node's own conversation (AwwO's node chat). The message is sent as written, with the node's
// persona as its instructions: it is NOT wrapped in the node's task framing or output contract, and
// an answer never replaces the node's output. Running the node does that.
import { useRef, useState } from 'react';
import type { SessionNode } from '@awwo/core/canvasDoc';
import { api } from './api';
import type { ChatTurn } from './Inspector';
import type { ShellTranslate } from './text';

const HISTORY_TURNS = 40;

export function useNodeChat(t: ShellTranslate) {
  const [chats, setChats] = useState<Record<string, ChatTurn[]>>({});
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const tRef = useRef(t);
  tRef.current = t;
  // Every change to this map comes with a change to `chats`, so reading it while rendering is current.
  const controllers = useRef(new Map<string, AbortController>());

  const update = (nodeId: string, change: (turns: ChatTurn[]) => ChatTurn[]) =>
    setChats(previous => ({ ...previous, [nodeId]: change(previous[nodeId] ?? []) }));

  const send = (node: SessionNode, message: string) => {
    const prompt = message.trim();
    if (!prompt || controllers.current.has(node.id)) return;
    // Only settled turns are history: a failed or stopped answer is not something the node said.
    const history = (chatsRef.current[node.id] ?? []).filter(turn => !turn.status && turn.content.trim())
      .slice(-HISTORY_TURNS).map(({ role, content }) => ({ role, content }));
    const controller = new AbortController();
    controllers.current.set(node.id, controller);
    update(node.id, turns => [...turns, { role: 'user', content: prompt }, { role: 'assistant', content: '', status: 'streaming' }]);
    let text = '';
    let paint: number | null = null;
    const replaceLast = (turn: ChatTurn) => update(node.id, turns => [...turns.slice(0, -1), turn]);
    const finish = (status: 'done' | 'failed' | 'cancelled', final: string, error = '') => {
      if (paint !== null) cancelAnimationFrame(paint);
      controllers.current.delete(node.id);
      replaceLast({ role: 'assistant', content: status === 'failed' && !final ? error : final, ...(status === 'done' ? {} : { status }) });
    };
    const end: { status?: 'done' | 'failed' | 'cancelled'; text?: string; error?: string } = {};
    void api.directRun({ prompt, persona: node.persona, messages: history, sessionId: `node_${node.id}`,
      ...(node.runtime ? { runtime: node.runtime } : {}), ...(node.model ? { model: node.model } : {}), ...(node.effort ? { effort: node.effort } : {}) }, frame => {
      if (frame.type === 'delta' && typeof frame.delta === 'string') {
        text += frame.delta;
        if (paint === null) paint = requestAnimationFrame(() => { paint = null; replaceLast({ role: 'assistant', content: text, status: 'streaming' }); });
      } else if (frame.type === 'completed') Object.assign(end, { status: 'done', text: typeof frame.text === 'string' ? frame.text : text });
      else if (frame.type === 'cancelled') Object.assign(end, { status: 'cancelled', text: typeof frame.text === 'string' ? frame.text : text });
      else if (frame.type === 'failed') Object.assign(end, { status: 'failed', text, error: typeof frame.error === 'string' ? frame.error : '' });
    }, controller.signal).then(
      () => end.status ? finish(end.status, end.text ?? text, end.error) : finish('failed', text, tRef.current('taskInterrupted')),
      failure => controller.signal.aborted ? finish('cancelled', text) : finish('failed', text, failure instanceof Error ? failure.message : String(failure)));
  };

  return {
    turns: (nodeId: string) => chats[nodeId] ?? [],
    busy: (nodeId: string) => controllers.current.has(nodeId),
    send,
    stop: (nodeId: string) => controllers.current.get(nodeId)?.abort(),
    clear: (nodeId: string) => {
      if (controllers.current.has(nodeId)) return;
      setChats(previous => {
        const next = { ...previous };
        delete next[nodeId];
        return next;
      });
    },
  };
}
