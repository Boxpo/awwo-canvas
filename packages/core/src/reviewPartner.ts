import { createSessionNode, type CanvasDocument, type SessionNode } from './canvasDoc';
import { edgeId, portsFor } from './ports';
import type { ContractField } from './nodeContracts';
import type { UiLocale } from './locale';

/** Additive starter: one real reviewer Session, an explicit verdict and a feedback input. */
export function addReviewPartner(doc: CanvasDocument, producerId: string, locale: UiLocale) {
  const producer = doc.nodes.find(node => node.id === producerId);
  if (producer?.kind !== 'session' || !producer.contract?.outputs.length) throw new Error('review_producer_required');
  const en = locale === 'en';
  const output = producer.contract.outputs[0];
  let feedbackId = 'review_feedback';
  while (producer.contract.inputs.some(field => field.id === feedbackId)) feedbackId += '_next';
  const field = (id: string, label: string, type: ContractField['type'], required: boolean, help: string): ContractField =>
    ({ id, label, type, required, value: '', help });
  const updated: SessionNode = { ...producer, contract: { ...producer.contract, inputs: [...producer.contract.inputs,
    field(feedbackId, en ? 'Review feedback' : '评审反馈', 'markdown', false,
      en ? 'Empty on the first round. Revise the deliverable using feedback from the previous round.' : '首轮为空；后续根据上一轮的具体反馈修改交付物。')] } };
  const reviewer: SessionNode = { ...createSessionNode('llm', { x: producer.x + producer.w + 160, y: producer.y }),
    title: en ? `${producer.title} · Reviewer` : `${producer.title} · 评审`,
    runtime: producer.runtime, model: producer.model, effort: producer.effort,
    persona: en
      ? 'Independently challenge the submitted deliverable. Verify it against the requirements and your evidence, identify concrete defects and give actionable revision requests. Approve only when the requirements are satisfied; never invent checks or agree merely to finish a round.'
      : '独立质疑并验证收到的交付物。根据要求与实际证据检查内容，指出具体缺陷并给出可执行的修改意见。只有满足要求才可通过；不要编造检查结果，不要为了结束轮次而附和。',
    contract: { version: 1, inputs: [
      field('artifact', en ? 'Deliverable to review' : '待评审产出', output.type, true, en ? 'Actual output from the producer.' : '来自生产节点的实际产出。'),
      { ...field('criteria', en ? 'Acceptance criteria' : '验收要求', 'markdown', true, en ? 'What this deliverable must satisfy.' : '这份交付物必须满足哪些要求。'),
        value: producer.contract.inputs.filter(f => f.value.trim()).map(f => `${f.label}: ${f.value}`).join('\n\n') },
    ], outputs: [
      field('approved', en ? 'Approved' : '是否通过', 'boolean', true, en ? 'true only after verification; false requests a revision.' : '验证通过填 true，需要修改填 false。'),
      field('feedback', en ? 'Review findings' : '评审意见', 'markdown', true, en ? 'List evidence, defects and specific corrections; explain approval when passed.' : '列出证据、问题与具体修改要求；通过时说明验收依据。'),
    ] },
  };
  const dataFrom = { nodeId: producer.id, portId: `out:${output.id}` };
  const dataTo = { nodeId: reviewer.id, portId: 'in:artifact' };
  const feedbackFrom = { nodeId: reviewer.id, portId: 'out:feedback' };
  const feedbackTo = { nodeId: producer.id, portId: `in:${feedbackId}` };
  return { reviewerId: reviewer.id, doc: { ...doc, nodes: [...doc.nodes.map(node => node.id === producer.id ? updated : node), reviewer],
    execution: { mode: 'review' as const, maxRounds: 3, reviewerNodeId: reviewer.id, verdictFieldId: 'approved' },
    edges: [...doc.edges,
      { id: edgeId(dataFrom, dataTo), fromNode: producer.id, fromPort: dataFrom.portId, toNode: reviewer.id, toPort: dataTo.portId,
        dataType: portsFor(producer).find(port => port.id === dataFrom.portId)!.dataType },
      { id: edgeId(feedbackFrom, feedbackTo), fromNode: reviewer.id, fromPort: feedbackFrom.portId, toNode: producer.id, toPort: feedbackTo.portId,
        dataType: 'text' as const, kind: 'feedback' as const },
    ] } };
}
