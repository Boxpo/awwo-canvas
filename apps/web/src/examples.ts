// Example canvases, assembled from AwwO's own templates and plan protocol rather than stored as
// JSON, so they always match the current contracts. Each one runs offline on the mock runtime.
import { createAgentTemplate, createDevelopmentTemplate } from '@awwo/core/agentTemplates';
import { emptyDocument, type CanvasDocument, type CanvasNode, type SessionNode } from '@awwo/core/canvasDoc';
import { applyCanvasPlan, parseCanvasPlan } from '@awwo/core/canvasPlan';
import { addReviewPartner } from '@awwo/core/reviewPartner';
import type { UiLocale } from './locale';

export type ExampleId = 'workflow' | 'review' | 'team';

/** Fill every required input that no wire feeds, so the example passes preflight as loaded. */
function fillRequired(doc: CanvasDocument, value: string): CanvasDocument {
  const wired = new Set(doc.edges.map(edge => `${edge.toNode}|${edge.toPort}`));
  const nodes = doc.nodes.map((node): CanvasNode => {
    if (node.kind !== 'session' || !node.contract) return node;
    const inputs = node.contract.inputs.map(field => field.required && !field.value.trim() && !wired.has(`${node.id}|in:${field.id}`) ? { ...field, value } : field);
    return { ...node, contract: { ...node.contract, inputs } };
  });
  return { ...doc, nodes };
}

export function exampleDocument(id: ExampleId, locale: UiLocale): CanvasDocument {
  const zh = locale === 'zh';
  const brief = zh
    ? '为一款精品咖啡订阅服务做一个上线页面：说明三档套餐、配送节奏和首月优惠，语气亲切、专业。'
    : 'A launch page for a specialty coffee subscription: explain three plans, delivery cadence and a first-month offer, in a warm, expert voice.';
  if (id === 'workflow') {
    const plan = parseCanvasPlan({ version: 1, summary: zh ? '示例：规划 → 撰写 → 验收' : 'Example: plan → write → review', operations: [
      { type: 'add_node', ref: 'goal', templateId: 'general', title: zh ? '梳理目标' : 'Clarify the goal', inputValues: { brief } },
      { type: 'add_node', ref: 'make', templateId: 'materials', title: zh ? '撰写页面内容' : 'Write the page' },
      { type: 'add_node', ref: 'check', templateId: 'review', title: zh ? '交付验收' : 'Review the delivery' },
      { type: 'connect', fromNode: 'goal', fromField: 'result', toNode: 'make', toField: 'brief' },
      { type: 'connect', fromNode: 'make', fromField: 'assets', toNode: 'check', toField: 'delivery' },
    ] });
    return fillRequired(applyCanvasPlan(emptyDocument(), plan, locale).doc, brief);
  }
  if (id === 'review') {
    const writer: SessionNode = { ...createAgentTemplate('general', { x: 80, y: 120 }, locale), title: zh ? '撰写标语' : 'Write the tagline' };
    const base = fillRequired({ ...emptyDocument(), nodes: [writer] }, brief);
    return fillRequired(addReviewPartner(base, writer.id, locale).doc, brief);
  }
  const team = createDevelopmentTemplate({ x: 80, y: 80 }, locale);
  return fillRequired({ ...emptyDocument(), nodes: team.nodes, edges: team.edges }, brief);
}
