import { describe, expect, it, vi } from 'vitest';
import { CANVAS_BACKUP_KEY, CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, sanitizeDocument, saveDocument, type CanvasEdge, type SessionNode } from '../src/canvasDoc';
import { canConnect, portsFor } from '../src/ports';
import { buildNodeMessage, preflightGraph, runGraph, validateNodeOutput, type RunNodeStatus } from '../src/runGraph';
import { emptyContract, normalizeContract, parseContractOutput, validateContractFields } from '../src/nodeContracts';

function field(id: string, type: 'text' | 'markdown' | 'html' | 'number' | 'boolean' | 'file' = 'text', value = '', required = true) {
  return { id, label: `字段 ${id}`, type, required, value };
}

function agent(id: string, inputs = [field('brief')], outputs = [field('result')]): SessionNode {
  return {
    ...createSessionNode('coding', { x: 0, y: 0 }),
    id,
    title: `Agent ${id}`,
    binding: { companyId: 'company', agentId: `agent-${id}`, agentName: id },
    contract: { version: 1, inputs, outputs },
  };
}

function wire(fromNode: string, toNode: string, fromPort = 'out:result', toPort = 'in:brief'): CanvasEdge {
  return { id: `${fromNode}-${toNode}-${fromPort}-${toPort}`, fromNode, toNode, fromPort, toPort, dataType: 'text' };
}

describe('node contract persistence and ports', () => {
  it('retains string field guidance and ignores malformed optional guidance without dropping the contract', () => {
    const valid = { ...field('brief'), help: '说明目标用户和验收方式。', placeholder: '例如：支持键盘操作的登录页' };
    const invalid = { ...field('other'), help: { text: 'not a string' }, placeholder: 42 };
    const normalized = normalizeContract({ version: 1, inputs: [valid, invalid], outputs: [{ ...field('result'), help: '', placeholder: '' }] });
    expect(normalized?.inputs[0]).toEqual(valid);
    expect(normalized?.inputs[1]).toEqual(field('other'));
    expect(normalized?.outputs[0]).toMatchObject({ help: '', placeholder: '' });
    expect(validateContractFields([valid])).toEqual(['「字段 brief」为必填项。']);
  });

  it('preserves guidance on document save and load without converting examples into input or output values', () => {
    const input = { ...field('brief', 'markdown'), help: '描述页面和用户操作。', placeholder: '例如：用户设置页面' };
    const output = { ...field('result', 'markdown'), help: '填写真实验证结果。', placeholder: '例如：构建通过，预览地址待补' };
    const source = agent('guidance', [input], [output]);
    localStorage.clear();
    saveDocument({ ...emptyDocument(), nodes: [source] });
    const restored = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
    expect(restored.contract).toEqual(source.contract);
    expect(restored.contract?.inputs[0].value).toBe('');
    expect(restored.contract?.outputs[0].value).toBe('');
    expect(restored.lastOutput).toBeNull();
    expect(preflightGraph([restored], [])).toContain('字段 brief');
    localStorage.clear();
  });

  it('creates independent empty forms and rejects unsupported or ambiguous field schemas', () => {
    const contract = emptyContract();
    contract.inputs.push(field('new'));
    expect(emptyContract().inputs).toEqual([]);
    expect(normalizeContract(undefined)).toBeUndefined();
    expect(normalizeContract({ version: 2, inputs: [], outputs: [] })).toBeUndefined();
    expect(normalizeContract({ version: 1, inputs: [field('same'), field('same')], outputs: [] })).toBeUndefined();
    expect(normalizeContract({ version: 1, inputs: [{ ...field('bad'), required: 'true' }], outputs: [] })).toBeUndefined();
    expect(normalizeContract({ version: 1, inputs: [{ ...field('bad'), type: 'unknown' }], outputs: [] })).toBeUndefined();
  });

  it('backs up an unsupported stored contract instead of silently downgrading it to legacy ports', () => {
    const raw = JSON.stringify({ ...emptyDocument(), nodes: [{ ...agent('source'), contract: { version: 9, inputs: [], outputs: [] } }] });
    localStorage.clear();
    localStorage.setItem(CANVAS_STORAGE_KEY, raw);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = loadDocumentWithStatus();
    log.mockRestore();
    expect(loaded.status).toBe('corrupt');
    expect(localStorage.getItem(CANVAS_BACKUP_KEY)).toBe(raw);
    expect(localStorage.getItem(CANVAS_STORAGE_KEY)).toBe(raw);
    localStorage.clear();
  });

  it('retains Markdown values and typed field connections after document reload', () => {
    const source = agent('source', [field('brief', 'markdown', '# Brief\n\n**Keep formatting**')], [field('count', 'number')]);
    const sink = agent('sink', [field('count', 'number')]);
    const edge = { ...wire(source.id, sink.id, 'out:count', 'in:count'), dataType: 'number' as const };
    const loaded = sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [source, sink], edges: [edge] })));
    expect((loaded.nodes[0] as SessionNode).contract).toEqual(source.contract);
    expect(loaded.edges).toEqual([edge]);
  });

  it('exposes named typed ports and allows text to Markdown without allowing text to number', () => {
    const source = agent('source', [], [field('summary'), field('count', 'number')]);
    const sink = agent('sink', [field('brief', 'markdown'), field('count', 'number'), field('approved', 'boolean'), field('asset', 'file')]);
    expect(portsFor(source)).toEqual([
      { id: 'out:summary', side: 'output', dataType: 'text', label: '字段 summary' },
      { id: 'out:count', side: 'output', dataType: 'number', label: '字段 count' },
    ]);
    expect(canConnect([source, sink], [], { nodeId: 'source', portId: 'out:summary' }, { nodeId: 'sink', portId: 'in:brief' })).toBe(true);
    expect(canConnect([source, sink], [], { nodeId: 'source', portId: 'out:summary' }, { nodeId: 'sink', portId: 'in:count' })).toBe(false);
    expect(portsFor(sink).find((p) => p.id === 'in:approved')?.dataType).toBe('boolean');
    expect(portsFor(sink).find((p) => p.id === 'in:asset')?.dataType).toBe('file');
    expect(canConnect([source, sink], [wire('source', 'sink', 'out:summary')], { nodeId: 'source', portId: 'out:summary' }, { nodeId: 'sink', portId: 'in:brief' })).toBe(false);
  });

  it('preserves legacy context/result ports when a session has no contract', () => {
    expect(portsFor(createSessionNode('coding', { x: 0, y: 0 })).map((p) => p.id)).toEqual(['context', 'result']);
  });
});

describe('contract execution', () => {
  const html = '<!doctype html>\n<html lang="zh"><head><title>交付</title></head><body><main>已完成</main></body></html>';

  it('preserves complete HTML through persistence, validation and named text ports', () => {
    const source = agent('html', [], [field('page', 'html')]);
    const parsed = parseContractOutput(source.contract!, html);
    expect(parsed).toEqual({ values: { page: html }, errors: [] });
    expect(parseContractOutput(source.contract!, `\u0060\u0060\u0060html\n${html}\n\u0060\u0060\u0060`)).toEqual(parsed);
    expect(parseContractOutput(source.contract!, JSON.stringify({ page: html }))).toEqual(parsed);
    expect(normalizeContract(source.contract)).toEqual(source.contract);
    expect(portsFor(source)).toEqual([{ id: 'out:page', side: 'output', label: '字段 page', dataType: 'text' }]);
    const restored = sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [source] })));
    expect((restored.nodes[0] as SessionNode).contract?.outputs[0].type).toBe('html');
  });

  it.each([
    '已生成 index.html', '/workspace/index.html', '[网页](index.html)', '<main>只有片段</main>',
    '<html><head></head><body>未闭合', '<!-- <html><head></head><body>伪造</body></html> -->',
    '下面是网页：\n<html><head></head><body>好</body></html>',
    '<html><head></head><body><script>"</body></html>"</script>',
    '<html data-example="<head></head>"><body>伪造 head</body></html>',
    '<html><head></head><body>好</body></html>额外说明',
  ])('rejects a non-document HTML result: %s', output => {
    const source = agent('html', [], [field('page', 'html')]);
    expect(parseContractOutput(source.contract!, output).errors.join(' ')).toContain('完整 HTML');
    expect(validateContractFields([field('page', 'html', output)])).toHaveLength(1);
  });

  it('accepts scripts and tag-like strings only as inert document source', () => {
    const source = agent('html', [], [field('page', 'html')]);
    const output = '<html><head><style>body::before { content: "<body>" }</style></head><body><script>const sample = "</body></html>";</script><p title="<head>">完成</p></body></html>';
    expect(parseContractOutput(source.contract!, output)).toEqual({ values: { page: output }, errors: [] });
    expect(buildNodeMessage(source, [])).toContain('不能用文件路径');
    expect(validateNodeOutput(agent('md', [], [field('report', 'markdown')]), '普通文字也是合法的 Markdown。')).toEqual([]);
  });

  it('blocks downstream dispatch when a successful Agent supplies a path instead of HTML', async () => {
    const source = agent('source', [], [field('result', 'html')]);
    const sink = agent('sink');
    const execAgent = vi.fn(async () => ({ ok: true, output: '/tmp/index.html' }));
    const summary = await runGraph({ nodes: [source, sink], edges: [wire('source', 'sink')], execAgent, onStatus: () => {} });
    expect(summary).toMatchObject({ ok: false, failed: 1, blocked: 1 });
    expect(execAgent).toHaveBeenCalledTimes(1);
  });

  it('passes HTML document source without its fence to downstream and rejects invalid cached HTML', async () => {
    const source = agent('source', [], [field('result', 'html')]);
    const sink = agent('sink');
    const execAgent = vi.fn(async (node: SessionNode, message: string) => ({ ok: true, output: node.id === 'source' ? `\u0060\u0060\u0060html\n${html}\n\u0060\u0060\u0060` : message }));
    const summary = await runGraph({ nodes: [source, sink], edges: [wire('source', 'sink')], execAgent, onStatus: () => {} });
    expect(summary.ok).toBe(true);
    const message = execAgent.mock.calls.find(([node]) => node.id === 'sink')![1];
    expect(message).toContain(html);
    expect(message).not.toContain('\u0060\u0060\u0060html');
    execAgent.mockClear();
    const cached = await runGraph({ nodes: [source, sink], edges: [wire('source', 'sink')],
      scope: ['sink'], storedOutput: () => '/tmp/page.html', execAgent, onStatus: () => {} });
    expect(cached.ok).toBe(false);
    expect(execAgent).not.toHaveBeenCalled();
  });

  it('validates typed local values without treating false and zero as missing', () => {
    expect(validateContractFields([field('zero', 'number', '0'), field('false', 'boolean', 'false'), field('optional', 'number', '', false)])).toEqual([]);
    const errors = validateContractFields([field('amount', 'number', 'Infinity'), field('enabled', 'boolean', 'yes'), field('brief', 'markdown', '  ')]);
    expect(errors).toHaveLength(3);
    expect(errors.join(' ')).toContain('字段 amount');
    expect(errors.join(' ')).toContain('字段 enabled');
    expect(errors.join(' ')).toContain('字段 brief');
  });

  it('shares strict typed result validation with manual publication and accepts plain Markdown', () => {
    const node = agent('source', [], [field('summary', 'markdown'), field('count', 'number'), field('approved', 'boolean'), field('asset', 'file', '', false)]);
    expect(validateNodeOutput(node, '{"summary":"# Result","count":0,"approved":false}')).toEqual([]);
    expect(parseContractOutput(node.contract!, '{"summary":"# Result","count":0,"approved":false}').values).toEqual({ summary: '# Result', count: '0', approved: 'false' });
    expect(validateNodeOutput(node, '{"summary":"ok","count":"0","approved":"false"}')).toHaveLength(2);
    expect(validateNodeOutput(node, '{"summary":"ok","count":0,"approved":false,"asset":null}')).toEqual([]);
    expect(validateNodeOutput(agent('text', [], [field('result', 'markdown')]), '# Plain result\n\n**Ready**')).toEqual([]);
    expect(validateNodeOutput(node, 'prose without a JSON object').join(' ')).toContain('JSON');
  });

  it.each([undefined, null, ''])('treats an absent optional file as omitted in parsed output and downstream execution (%s)', async asset => {
    const source = agent('source', [], [field('result', 'markdown'), field('asset', 'file', '', false)]);
    const sink = agent('sink');
    const output = JSON.stringify({ result: '# Actual report', asset });
    expect(parseContractOutput(source.contract!, output)).toEqual({ values: { result: '# Actual report' }, errors: [] });
    const execute = vi.fn(async (node: SessionNode) => ({ ok: true, output: node.id === 'source' ? output : 'Accepted report' }));
    const summary = await runGraph({ nodes: [source, sink], edges: [wire('source', 'sink')], execAgent: execute, onStatus: () => {} });
    expect(summary.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('still rejects empty required files and null values of every other optional type', () => {
    const required = agent('required', [], [field('asset', 'file')]);
    for (const asset of [undefined, null, '']) expect(validateNodeOutput(required, JSON.stringify({ asset }))).toHaveLength(1);
    for (const type of ['text', 'markdown', 'html', 'number', 'boolean'] as const) {
      const optional = agent('optional', [], [field('result'), field('other', type, '', false)]);
      expect(validateNodeOutput(optional, JSON.stringify({ result: 'Actual result', other: null }))).toHaveLength(1);
    }
  });

  it('accepts JSON code samples as the plain content of a single Markdown output', () => {
    const node = agent('source', [], [field('result', 'markdown')]);
    const markdown = '```json\n{"example":true}\n```';
    expect(parseContractOutput(node.contract!, markdown)).toEqual({ values: { result: markdown }, errors: [] });
    expect(parseContractOutput(node.contract!, '{"result":"Explicit wrapped value"}')).toEqual({ values: { result: 'Explicit wrapped value' }, errors: [] });
  });

  it('rejects conflicting multiple sources for one contract input while leaving legacy fan-in intact', () => {
    const first = agent('first', []);
    const second = agent('second', []);
    const sink = agent('sink');
    expect(preflightGraph([first, second, sink], [wire('first', 'sink'), wire('second', 'sink')])).toContain('字段 brief');
    expect(() => buildNodeMessage(agent('sink'), [
      { fromTitle: 'First', toPort: 'in:brief', output: 'one' },
      { fromTitle: 'Second', toPort: 'in:brief', output: 'two' },
    ])).toThrow('字段 brief');
  });

  it('names missing local inputs before execution but accepts a valid incoming wire', () => {
    const source = agent('source', []);
    const sink = agent('sink');
    expect(preflightGraph([sink], [])).toContain('字段 brief');
    expect(preflightGraph([source, sink], [wire('source', 'sink')])).toBeNull();
    expect(preflightGraph([source, sink], [wire('source', 'sink', 'out:missing')])).toContain('字段 brief');
  });

  it('includes local Markdown, false and zero inputs and declares keyed typed outputs', () => {
    const node = agent('source', [field('brief', 'markdown', '# Build this'), field('count', 'number', '0'), field('approved', 'boolean', 'false')], [field('summary'), field('count', 'number')]);
    const prompt = buildNodeMessage(node, []);
    expect(prompt).toContain('# Build this');
    expect(prompt).toContain('0');
    expect(prompt).toContain('false');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('summary');
    expect(prompt).toContain('number');
  });

  it('passes only the selected output field into the named downstream input', async () => {
    const source = agent('source', [], [field('summary'), field('private_notes')]);
    const sink = agent('sink');
    const messages: Record<string, string> = {};
    const summary = await runGraph({
      nodes: [source, sink], edges: [wire('source', 'sink', 'out:summary')],
      execAgent: async (node, message) => {
        messages[node.id] = message;
        return { ok: true, output: node.id === 'source' ? '```json\n{"summary":"Selected brief","private_notes":"Do not forward this"}\n```' : 'Done', detail: '完成' };
      }, onStatus: () => {},
    });
    expect(summary).toMatchObject({ ok: true, done: 2 });
    expect(messages.sink).toContain('字段 brief');
    expect(messages.sink).toContain('Selected brief');
    expect(messages.sink).not.toContain('Do not forward this');
  });

  it('marks a successful transport with malformed typed output failed and blocks its downstream', async () => {
    const statuses: Record<string, RunNodeStatus> = {};
    const executed: string[] = [];
    const source = agent('source', [], [field('summary'), field('count', 'number')]);
    const sink = agent('sink');
    const summary = await runGraph({
      nodes: [source, sink], edges: [wire('source', 'sink', 'out:summary')],
      execAgent: async (node) => { executed.push(node.id); return { ok: true, output: '{"summary":"Brief","count":"oops"}', detail: '完成' }; },
      onStatus: (id, status) => { statuses[id] = status; },
    });
    expect(summary).toMatchObject({ ok: false, failed: 1, blocked: 1 });
    expect(statuses.source).toMatchObject({ state: 'failed', output: '{"summary":"Brief","count":"oops"}' });
    expect(statuses.source.detail).toContain('字段 count');
    expect(statuses.sink.state).toBe('blocked');
    expect(executed).toEqual(['source']);
  });

  it('refuses missing required inputs even if the caller bypasses preflight', async () => {
    const executed: string[] = [];
    const statuses: Record<string, RunNodeStatus> = {};
    const summary = await runGraph({ nodes: [agent('source')], edges: [],
      execAgent: async (node) => { executed.push(node.id); return { ok: true, output: 'Done', detail: '' }; },
      onStatus: (id, status) => { statuses[id] = status; },
    });
    expect(executed).toEqual([]);
    expect(summary.ok).toBe(false);
    expect(statuses.source.detail).toContain('字段 brief');
  });

  it('validates cached output before allowing a scoped downstream run', async () => {
    const source = agent('source', [], [field('summary'), field('count', 'number')]);
    const sink = agent('sink');
    const statuses: Record<string, RunNodeStatus> = {};
    const executed: string[] = [];
    const summary = await runGraph({ nodes: [source, sink], edges: [wire('source', 'sink', 'out:summary')], scope: ['sink'],
      storedOutput: () => '{"summary":"Brief"}',
      execAgent: async (node) => { executed.push(node.id); return { ok: true, output: 'Done', detail: '' }; },
      onStatus: (id, status) => { statuses[id] = status; },
    });
    expect(executed).toEqual([]);
    expect(summary).toMatchObject({ ok: false, cached: 0, total: 1, blocked: 1 });
    expect(statuses.source).toBeUndefined();
    expect(statuses.sink.detail).toContain('字段 count');
    expect(statuses.sink.state).toBe('blocked');
  });

  it('does not execute through a forged incompatible wire even when the text looks numeric', async () => {
    const source = agent('source', [], [field('result')]);
    const sink = agent('sink', [field('count', 'number')]);
    const executed: string[] = [];
    const summary = await runGraph({ nodes: [source, sink], edges: [wire('source', 'sink', 'out:result', 'in:count')],
      execAgent: async (node) => { executed.push(node.id); return { ok: true, output: '42', detail: '' }; },
      onStatus: () => {},
    });
    expect(executed).toEqual(['source']);
    expect(summary.ok).toBe(false);
  });

  it('maps valid cached typed output without re-executing its source', async () => {
    const source = agent('source', [], [field('count', 'number'), field('notes')]);
    const sink = agent('sink', [field('count', 'number')]);
    const messages: string[] = [];
    const summary = await runGraph({ nodes: [source, sink], edges: [{ ...wire('source', 'sink', 'out:count', 'in:count'), dataType: 'number' }], scope: ['sink'],
      storedOutput: () => '{"count":0,"notes":"Not connected"}',
      execAgent: async (node, message) => { messages.push(`${node.id}: ${message}`); return { ok: true, output: 'Done', detail: '' }; },
      onStatus: () => {},
    });
    expect(summary).toMatchObject({ ok: true, cached: 1, done: 1, total: 1 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('0');
    expect(messages[0]).not.toContain('Not connected');
  });

  it('blocks a required wired input when its optional upstream field was omitted', async () => {
    const source = agent('source', [], [field('summary'), field('extra', 'text', '', false)]);
    const sink = agent('sink');
    const executed: string[] = [];
    const summary = await runGraph({ nodes: [source, sink], edges: [wire('source', 'sink', 'out:extra')],
      execAgent: async (node) => { executed.push(node.id); return { ok: true, output: '{"summary":"Ready"}', detail: '' }; },
      onStatus: () => {},
    });
    expect(executed).toEqual(['source']);
    expect(summary.ok).toBe(false);
  });
});
