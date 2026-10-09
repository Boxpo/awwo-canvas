// Frozen output policy (ported from AwwO backend/internal/app/graph_contracts.go).
//
// The policy is generated from the same frozen output fields that validate the reply, so the
// format the model is asked for can never disagree with the format the orchestrator accepts.
// Saved values are never used as examples: they may be stale prior deliverables.
import type { NodeContract } from '@awwo/core/nodeContracts';
import { fill, type SkillRegistry } from '../skills';

const SKILL = 'node-delivery';

export function allowsPlainTextOutput(contract: NodeContract | undefined): boolean {
  const outputs = contract?.outputs ?? [];
  return outputs.length === 1 && ['text', 'markdown', 'html'].includes(outputs[0].type);
}

export function graphOutputPolicy(contract: NodeContract | undefined, skills: SkillRegistry): string {
  if (!contract || contract.outputs.length === 0) return '';
  const fields = contract.outputs.map(field => ({ id: field.id, label: field.label, type: field.type, required: field.required,
    help: field.help ?? '', placeholder: field.placeholder ?? '' }));
  const example: Record<string, unknown> = {};
  for (const field of contract.outputs) {
    switch (field.type) {
      case 'number': example[field.id] = 0; break;
      case 'boolean': example[field.id] = false; break;
      case 'html': example[field.id] = '<html><head></head><body>Actual result</body></html>'; break;
      case 'file': example[field.id] = '<reference to the actual file>'; break;
      default: example[field.id] = `<actual ${field.id} content>`;
    }
  }
  const block = (name: string) => skills.block(SKILL, name).trim();
  const values = { fields: JSON.stringify(fields), example: JSON.stringify(example) };
  let policy = `${fill(block('policy-intro'), values)} `;
  if (allowsPlainTextOutput(contract)) {
    policy += fill(block('single-text'), values);
    policy += `\n${block('plain-text-allowance')}\n${block('exact-text-guidance')}`;
  } else {
    policy += fill(block('multi-field'), values);
    policy += `\n${block('json-only')}`;
  }
  if (contract.outputs.some(field => field.type === 'html')) policy += `\n${block('html')}`;
  if (contract.outputs.some(field => field.type === 'file')) policy += `\n${block('file')}`;
  return policy;
}

export function graphSystemPrompt(instructions: string, policy: string, skills: SkillRegistry): string {
  if (!policy) return instructions;
  return fill(skills.block(SKILL, 'system-wrapper').trim(), { persona: JSON.stringify(instructions), policy });
}
