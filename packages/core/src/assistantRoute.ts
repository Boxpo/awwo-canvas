// The canvas assistant's one conversation (from AwwO apps/web/src/canvas/assistantRouting.ts).
//
// Each message is handled in exactly one of two ways and the SERVER decides which:
//   plan    — arrange the canvas: the planner proposes operations the canvas validates and applies;
//   execute — do the work now: one agent carries out the task and hands back the result.
// The client says which ways it can carry out; the server narrows that to what is configured,
// routes explicit canvas-edit wording by rule, otherwise asks a small model, and falls back to
// `plan` (cheap, undone in one step) whenever it cannot tell. See skills/assistant-router.

import type { CanvasDocument } from './canvasDoc';
import type { PlanningMessage } from './planningContext';

export type AssistantRoute = 'plan' | 'execute';
/** only: one way was possible · rule: wording names a canvas edit · model: the router model · fallback: the default. */
export type AssistantRouteBasis = 'only' | 'rule' | 'model' | 'fallback';

/** What the server's router reads; the bounds are the server's. */
export interface AssistantRouteRequest {
  message: string;
  routes: AssistantRoute[];
  canvas: { nodes: number; titles: string[]; results: boolean };
  recent: Array<{ role: 'user' | 'assistant'; route?: AssistantRoute; text: string }>;
}

export interface AssistantRouteResult { route: AssistantRoute; basis: AssistantRouteBasis }

export const ROUTE_LIMITS = { message: 8000, titles: 40, titleChars: 120, turns: 6, turnChars: 600 } as const;

/** The router's input, within the server's bounds: the canvas in brief and the last turns of the conversation. */
export function assistantRouteRequest(message: string, routes: AssistantRoute[], doc: CanvasDocument, messages: PlanningMessage[]): AssistantRouteRequest {
  const clip = (text: string, max: number) => [...text].slice(0, max).join('');
  return {
    message,
    routes,
    canvas: {
      nodes: doc.nodes.length,
      titles: doc.nodes.slice(0, ROUTE_LIMITS.titles).map(node => clip(node.title.trim(), ROUTE_LIMITS.titleChars)).filter(Boolean),
      results: doc.nodes.some(node => Boolean(node.lastOutput)),
    },
    recent: messages.slice(-ROUTE_LIMITS.turns).map(item => ({
      role: item.role,
      ...(item.route ? { route: item.route } : {}),
      text: clip(item.taskId ? '(a task was started)' : item.content, ROUTE_LIMITS.turnChars),
    })),
  };
}
