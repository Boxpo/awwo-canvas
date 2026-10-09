// Hot-plug runtime registry.
//
// AwwO's Go control plane routes every model call to a worker by runtime id and learns what that
// worker can do only from the worker itself (GET /health). This registry keeps that design and
// generalizes the fixed pair of runtimes into a registry, so an engine can be plugged in or out
// while the orchestrator runs:
//   - runtimes.json is watched; edits apply without a restart;
//   - POST /api/runtimes registers a worker at runtime (and DELETE removes it);
//   - every entry is re-probed periodically and again at admission, so a worker that was just
//     started is usable on the next run and one that died is refused, never silently replaced.
// Catalog validation is ported from AwwO's probeRuntime: a worker must declare its runtime on
// every model (a miswired URL cannot reroute a request to another SDK), its default model must be
// in its catalog, and tool/effort/budget claims are bounded.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import {
  MAX_CONTEXT_TEXT_BYTES, MAX_RUNTIME_MODELS, RUNTIME_ID_PATTERN,
  type RuntimeHealth, type RuntimeModel, type RuntimeTool, type RuntimeView,
} from '@awwo/core/protocol';

export interface RuntimeConfigEntry { id: string; label?: string; url: string; token?: string; tokenEnv?: string }

interface Entry {
  id: string;
  label: string;
  url: string;
  token: string;
  source: 'file' | 'api';
  health: RuntimeHealth | null;
  status: RuntimeView['status'];
  error?: string;
  checkedAt: number;
  probing?: Promise<void>;
}

export class RuntimeUnavailable extends Error {
  constructor(readonly runtime: string, message: string) {
    super(message);
    this.name = 'RuntimeUnavailable';
  }
}

const EFFORT_LEVEL = /^[a-z][a-z0-9_-]{0,31}$/;
const TOOL_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_HEALTH_BYTES = 512 * 1024;

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

/** Validate one worker's /health answer for the runtime id it is registered under. Throws with a reason. */
export function validateHealth(runtime: string, raw: unknown): RuntimeHealth {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Health answer is not a JSON object');
  const h = raw as Record<string, unknown>;
  if (h.ready !== true) throw new Error('Runtime reports it is not ready');
  if (h.protocol !== undefined && h.protocol !== 1) throw new Error(`Unsupported worker protocol ${String(h.protocol)}`);
  if (h.runtime !== undefined && h.runtime !== runtime) throw new Error(`Worker serves runtime "${String(h.runtime)}", registered as "${runtime}"`);
  if (!bounded(h.model, 200)) throw new Error('Runtime default model is missing');
  if (!Array.isArray(h.models) || h.models.length === 0) throw new Error('Runtime model catalog is empty');
  if (h.models.length > MAX_RUNTIME_MODELS) throw new Error('Runtime model catalog exceeds limit');
  const seen = new Set<string>();
  const models: RuntimeModel[] = h.models.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Runtime model catalog is invalid');
    const m = item as Record<string, unknown>;
    if (!bounded(m.id, 200) || seen.has(m.id)) throw new Error('Runtime model ids must be unique and bounded');
    // Every model must name its runtime: a worker answering on the wrong URL is refused.
    if (m.runtime !== runtime) throw new Error(`Model "${m.id}" belongs to runtime "${String(m.runtime)}", not "${runtime}"`);
    if (m.provider !== undefined && (typeof m.provider !== 'string' || m.provider.length > 200)) throw new Error('Runtime model provider is invalid');
    const efforts = m.reasoningEfforts === undefined ? [] : m.reasoningEfforts;
    if (!Array.isArray(efforts) || efforts.length > 8 || efforts.some(level => typeof level !== 'string' || !EFFORT_LEVEL.test(level))
      || new Set(efforts).size !== efforts.length) throw new Error(`Model "${m.id}" advertises invalid reasoning efforts`);
    const defaultEffort = typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : '';
    if (defaultEffort && !efforts.includes(defaultEffort)) throw new Error(`Model "${m.id}" default effort is not in its list`);
    const budget = typeof m.maxContextTextBytes === 'number' && Number.isInteger(m.maxContextTextBytes) && m.maxContextTextBytes > 0
      ? Math.min(m.maxContextTextBytes, MAX_CONTEXT_TEXT_BYTES) : MAX_CONTEXT_TEXT_BYTES;
    const overhead = typeof m.messageOverheadBytes === 'number' && Number.isInteger(m.messageOverheadBytes) && m.messageOverheadBytes >= 0
      ? Math.min(m.messageOverheadBytes, 65_536) : 0;
    seen.add(m.id);
    return {
      id: m.id, runtime, model: typeof m.model === 'string' ? m.model.slice(0, 200) : m.id,
      provider: typeof m.provider === 'string' ? m.provider : '', label: typeof m.label === 'string' ? m.label.slice(0, 200) : m.id,
      maxContextTextBytes: budget, messageOverheadBytes: overhead, reasoningEfforts: efforts as string[], defaultReasoningEffort: defaultEffort,
    };
  });
  if (!seen.has(h.model)) throw new Error('Runtime default model is missing from its catalog');
  const rawTools = h.tools === undefined ? [] : h.tools;
  if (!Array.isArray(rawTools)) throw new Error('Runtime tool catalog is invalid');
  const toolIds = new Set<string>();
  const tools: RuntimeTool[] = rawTools.map((item: unknown) => {
    const t = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof t.id !== 'string' || !TOOL_ID.test(t.id) || toolIds.has(t.id)) throw new Error('Runtime tool ids must be unique catalog ids');
    if (typeof t.contextTextBytes !== 'number' || !Number.isInteger(t.contextTextBytes) || t.contextTextBytes < 1 || t.contextTextBytes > 65_536) {
      throw new Error(`Tool "${t.id}" budget must be 1–65536 bytes`);
    }
    toolIds.add(t.id);
    return { id: t.id, contextTextBytes: t.contextTextBytes, ...(typeof t.description === 'string' ? { description: t.description.slice(0, 500) } : {}) };
  });
  const count = (value: unknown, fallback: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
  return {
    ready: true, protocol: 1, runtime, model: h.model, models, tools,
    maxConcurrency: Math.max(1, count(h.maxConcurrency, 1)), activeRuns: count(h.activeRuns, 0),
    completionOptions: Array.isArray(h.completionOptions) ? h.completionOptions.filter((option): option is string => typeof option === 'string').slice(0, 16) : [],
    sdkVersion: typeof h.sdkVersion === 'string' ? h.sdkVersion.slice(0, 120) : '',
  };
}

export function modelEntry(health: RuntimeHealth, model: string): RuntimeModel | undefined {
  return health.models.find(item => item.id === (model || health.model));
}

/** The input budget and per-message overhead of a model, or null when the runtime does not offer it. */
export function modelLimits(health: RuntimeHealth, model: string): { budget: number; overhead: number } | null {
  const entry = modelEntry(health, model);
  return entry ? { budget: entry.maxContextTextBytes ?? MAX_CONTEXT_TEXT_BYTES, overhead: entry.messageOverheadBytes ?? 0 } : null;
}

/** An explicit effort is accepted only when the worker advertises that exact level for that model. */
export function supportsEffort(health: RuntimeHealth, model: string, effort: string): boolean {
  if (!effort) return true;
  return modelEntry(health, model)?.reasoningEfforts?.includes(effort) ?? false;
}

export function toolBudget(health: RuntimeHealth, tools: readonly string[]): number | null {
  let total = 0;
  for (const id of tools) {
    const tool = health.tools?.find(item => item.id === id);
    if (!tool) return null;
    total += tool.contextTextBytes;
  }
  return total;
}

export interface RegistryOptions {
  file: string;
  probeIntervalMs: number;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export class RuntimeRegistry extends EventEmitter {
  private entries = new Map<string, Entry>();
  private watcher: FSWatcher | null = null;
  private interval: NodeJS.Timeout | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private configuredDefault = '';
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  constructor(private readonly options: RegistryOptions) {
    super();
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? (() => {});
  }

  async start(): Promise<void> {
    this.loadFile();
    if (existsSync(this.options.file)) {
      try {
        this.watcher = watch(this.options.file, () => {
          if (this.reloadTimer) clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => { this.loadFile(); void this.probeAll(); }, 150);
        });
      } catch (error) {
        this.log(`runtimes file watch unavailable: ${error instanceof Error ? error.message : error}`);
      }
    }
    await this.probeAll();
    if (this.options.probeIntervalMs > 0) {
      this.interval = setInterval(() => void this.probeAll(), this.options.probeIntervalMs);
      this.interval.unref?.();
    }
  }

  stop(): void {
    this.watcher?.close();
    if (this.interval) clearInterval(this.interval);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  /** (Re)read runtimes.json. File entries are replaced as a set; API registrations are kept. */
  loadFile(): void {
    let parsed: { defaultRuntime?: unknown; runtimes?: unknown } = {};
    if (existsSync(this.options.file)) {
      try {
        parsed = JSON.parse(readFileSync(this.options.file, 'utf8').replace(/^\uFEFF/, ''));
      } catch (error) {
        this.log(`runtimes file ignored (invalid JSON): ${error instanceof Error ? error.message : error}`);
        return;
      }
    }
    this.configuredDefault = typeof parsed.defaultRuntime === 'string' ? parsed.defaultRuntime : '';
    const fileEntries = new Map<string, RuntimeConfigEntry>();
    for (const item of Array.isArray(parsed.runtimes) ? parsed.runtimes : []) {
      try {
        const entry = this.normalize(item as RuntimeConfigEntry);
        fileEntries.set(entry.id, entry);
      } catch (error) {
        this.log(`runtime entry skipped: ${error instanceof Error ? error.message : error}`);
      }
    }
    for (const [id, entry] of this.entries) {
      if (entry.source === 'file' && !fileEntries.has(id)) this.entries.delete(id);
    }
    for (const config of fileEntries.values()) {
      const current = this.entries.get(config.id);
      if (current?.source === 'api') continue; // an API registration of the same id wins until removed
      const token = this.tokenOf(config);
      if (current && current.url === config.url && current.token === token) {
        current.label = config.label || config.id;
        continue;
      }
      this.entries.set(config.id, { id: config.id, label: config.label || config.id, url: config.url, token, source: 'file',
        health: null, status: 'probing', checkedAt: 0 });
    }
    this.emit('change');
  }

  private normalize(input: RuntimeConfigEntry): RuntimeConfigEntry {
    if (!input || typeof input !== 'object') throw new Error('Runtime entry must be an object');
    if (typeof input.id !== 'string' || !RUNTIME_ID_PATTERN.test(input.id)) throw new Error('Runtime id must match ^[a-z][a-z0-9_-]{0,63}$');
    let url: URL;
    try { url = new URL(String(input.url)); } catch { throw new Error(`Runtime "${input.id}" has an invalid url`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Runtime "${input.id}" url must be http(s)`);
    if (url.username || url.password) throw new Error(`Runtime "${input.id}" url must not embed credentials; use tokenEnv`);
    return { id: input.id, label: typeof input.label === 'string' ? input.label.slice(0, 120) : input.id,
      url: url.toString().replace(/\/+$/, ''),
      ...(typeof input.token === 'string' ? { token: input.token } : {}),
      ...(typeof input.tokenEnv === 'string' ? { tokenEnv: input.tokenEnv } : {}) };
  }

  private tokenOf(config: RuntimeConfigEntry): string {
    if (config.token) return config.token;
    if (config.tokenEnv) return (this.options.env ?? process.env)[config.tokenEnv] ?? '';
    return '';
  }

  /** Plug a worker in at runtime. The same id from runtimes.json cannot be shadowed silently. */
  async register(input: RuntimeConfigEntry): Promise<RuntimeView> {
    const config = this.normalize(input);
    const current = this.entries.get(config.id);
    if (current?.source === 'file') throw new Error(`Runtime "${config.id}" is defined in runtimes.json; edit the file instead`);
    this.entries.set(config.id, { id: config.id, label: config.label || config.id, url: config.url, token: this.tokenOf(config),
      source: 'api', health: null, status: 'probing', checkedAt: 0 });
    this.emit('change');
    await this.probe(config.id);
    return this.view(config.id)!;
  }

  unregister(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.source === 'file') throw new Error(`Runtime "${id}" is defined in runtimes.json; remove it there`);
    this.entries.delete(id);
    this.loadFile(); // a file entry with the same id becomes visible again
    this.emit('change');
    return true;
  }

  async probeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(id => this.probe(id)));
  }

  /** Ask the worker what it serves. Concurrent probes of one runtime share a request. */
  probe(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.probing) return entry.probing;
    entry.probing = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        const response = await this.fetchImpl(`${entry.url}/health`, {
          headers: entry.token ? { authorization: `Bearer ${entry.token}` } : {}, signal: controller.signal,
        });
        const text = await response.text();
        if (text.length > MAX_HEALTH_BYTES) throw new Error('Health answer exceeds 512 KiB');
        if (!response.ok) throw new Error(`Health check answered HTTP ${response.status}`);
        let body: unknown;
        try { body = JSON.parse(text); } catch { throw new Error('Health answer is not JSON'); }
        entry.health = validateHealth(id, body);
        entry.status = 'ready';
        delete entry.error;
      } catch (error) {
        const before = entry.status;
        entry.health = null;
        entry.status = 'unavailable';
        entry.error = controller.signal.aborted ? 'Health check timed out' : error instanceof Error ? error.message : String(error);
        if (before === 'ready') this.log(`runtime ${id} became unavailable: ${entry.error}`);
      } finally {
        clearTimeout(timer);
        entry.checkedAt = Date.now();
        entry.probing = undefined;
        if (this.entries.get(id) === entry) this.emit('change');
      }
    })();
    return entry.probing;
  }

  /** The live catalog for an admission: re-probed when stale, refused when the worker is not ready. */
  async health(id: string, maxAgeMs = 5_000): Promise<RuntimeHealth> {
    const entry = this.entries.get(id);
    if (!entry) throw new RuntimeUnavailable(id, `Runtime "${id}" is not registered`);
    if (entry.status !== 'ready' || Date.now() - entry.checkedAt > maxAgeMs) await this.probe(id);
    const current = this.entries.get(id);
    if (!current?.health || current.status !== 'ready') throw new RuntimeUnavailable(id, current?.error ? `Runtime "${id}" is unavailable: ${current.error}` : `Runtime "${id}" is unavailable`);
    return current.health;
  }

  /** Endpoint and token are orchestrator configuration only; never returned to a client. */
  endpoint(id: string): { url: string; token: string } {
    const entry = this.entries.get(id);
    if (!entry) throw new RuntimeUnavailable(id, `Runtime "${id}" is not registered`);
    return { url: entry.url, token: entry.token };
  }

  /** preferred → runtimes.json defaultRuntime → first ready runtime. '' when none is ready. */
  defaultRuntime(preferred = ''): string {
    const ready = (id: string) => this.entries.get(id)?.status === 'ready';
    if (preferred && ready(preferred)) return preferred;
    if (this.configuredDefault && ready(this.configuredDefault)) return this.configuredDefault;
    return [...this.entries.values()].find(entry => entry.status === 'ready')?.id ?? '';
  }

  view(id: string): RuntimeView | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const health = entry.health;
    return {
      id: entry.id, label: entry.label, status: entry.status, ...(entry.error ? { error: entry.error } : {}), source: entry.source,
      defaultModel: health?.model ?? '',
      models: (health?.models ?? []).map(model => ({ id: model.id, label: model.label || model.id, provider: model.provider ?? '',
        reasoningEfforts: model.reasoningEfforts ?? [], defaultReasoningEffort: model.defaultReasoningEffort ?? '' })),
      tools: (health?.tools ?? []).map(tool => tool.id), maxConcurrency: health?.maxConcurrency ?? 0, activeRuns: health?.activeRuns ?? 0,
      sdkVersion: health?.sdkVersion ?? '', checkedAt: entry.checkedAt,
    };
  }

  list(): RuntimeView[] {
    return [...this.entries.keys()].sort().map(id => this.view(id)!);
  }
}
