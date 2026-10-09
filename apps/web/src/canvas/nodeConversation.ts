import type { CanvasEdge, CanvasNode, SessionNode } from './canvasDoc';
import { parseContractOutput, type ContractField } from './nodeContracts';
import { arePortTypesCompatible, portsFor } from './ports';
import { buildNodeMessage, validateNodeOutput, type UpstreamInput } from './runGraph';

export interface NodeConversationContext {
  messagePrefix: string;
  error?: string;
  /** Validated display values, copied from the contract and overlaid with connected outputs. */
  inputs?: ContractField[];
  /** Connected field ids mapped to upstream titles (or its saved id if the node was removed). */
  sources?: Record<string, string>;
  /** Connected field ids whose value is an upstream node's case recording, not a run of this workspace. */
  recorded?: Record<string, true>;
}

export function prepareNodeConversation(
  node: SessionNode,
  nodes: ReadonlyArray<CanvasNode> = [node],
  edges: ReadonlyArray<CanvasEdge> = [],
): NodeConversationContext {
  // Legacy sessions intentionally retain their free-form conversation behavior.
  if (!node.contract) return { messagePrefix: '' };
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  byId.set(node.id, node);
  const incoming = edges.filter((candidate) => candidate.toNode === node.id);
  const sources: Record<string, string> = Object.create(null);
  // Collect provenance first, including fields after an unavailable source. Error rendering
  // should still be able to explain every connection without exposing unvalidated values.
  for (const edge of incoming) {
    const field = node.contract.inputs.find((candidate) => `in:${candidate.id}` === edge.toPort);
    if (field) sources[field.id] = byId.get(edge.fromNode)?.title ?? edge.fromNode;
  }
  const upstream: UpstreamInput[] = [];
  const recorded: Record<string, true> = Object.create(null);
  for (const edge of incoming) {
    const source = byId.get(edge.fromNode);
    const input = portsFor(node).find((port) => port.side === 'input' && port.id === edge.toPort);
    const output = source && portsFor(source).find((port) => port.side === 'output' && port.id === edge.fromPort);
    if (!source || source.id === node.id || !input || !output || !arePortTypesCompatible(output.dataType, input.dataType)) {
      return { messagePrefix: '', sources, error: `输入「${input?.label || edge.toPort}」的上游连线已失效，请检查连接。` };
    }
    if (!source.lastOutput || !source.lastOutput.text.trim() || source.lastOutput.partial) {
      return { messagePrefix: '', sources, error: `上游「${source.title}」还没有可用的完整产出。` };
    }
    const errors = validateNodeOutput(source, source.lastOutput.text);
    if (errors.length) {
      return { messagePrefix: '', sources, error: `上游「${source.title}」产出不符合输出格式：${errors.join(' ')}` };
    }
    const text = source.kind === 'session' && source.contract
      ? parseContractOutput(source.contract, source.lastOutput.text).values[edge.fromPort.slice('out:'.length)] ?? ''
      : source.lastOutput.text;
    upstream.push({ fromTitle: source.title, toPort: edge.toPort, output: text });
    if (source.lastOutput.source === 'case') recorded[edge.toPort.slice('in:'.length)] = true;
  }
  try {
    const messagePrefix = buildNodeMessage(node, upstream);
    const inputs = node.contract.inputs.map((field) => {
      const connected = upstream.find((input) => input.toPort === `in:${field.id}`);
      return { ...field, value: connected ? connected.output : field.value };
    });
    return { messagePrefix, inputs, sources, recorded };
  } catch (error) {
    return { messagePrefix: '', sources, error: error instanceof Error ? error.message : '节点输入尚未就绪。' };
  }
}
