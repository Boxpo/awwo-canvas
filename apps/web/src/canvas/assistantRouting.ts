// The canvas assistant's routing types. The request/response contract lives in @awwo/core; the
// pending-message shape is UI state, so it stays with the web surface (as in AwwO).
export * from '@awwo/core/assistantRoute';

/** What a message being handled waits for before it joins the conversation. */
export type AssistantPendingPhase = 'routing' | 'starting' | 'stopping';
/** `operationId`: the submission identity a task being started is sent under. */
export interface AssistantPending { id: string; prompt: string; phase: AssistantPendingPhase; operationId?: string }
