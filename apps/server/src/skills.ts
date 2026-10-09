// Orchestration skills: the prompt text the orchestrator sends lives in skills/*/SKILL.md, not in
// code. Each skill is a markdown file with a small frontmatter and named blocks:
//
//   ### block: system
//   ```text
//   …prompt text…
//   ```
//
// The registry reloads when a file changes, so a prompt can be tuned while the server runs
// (already-admitted runs keep the text they were admitted with). A required block that is
// missing is a startup error, never a silent fallback to some other wording.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

export interface Skill {
  name: string;
  version: string;
  description: string;
  path: string;
  sha256: string;
  blocks: Record<string, string>;
}

export const REQUIRED_BLOCKS: Record<string, readonly string[]> = {
  'canvas-planner': ['system'],
  'assistant-router': ['system', 'execute-system'],
  'node-delivery': ['system-wrapper', 'policy-intro', 'single-text', 'plain-text-allowance', 'exact-text-guidance', 'multi-field', 'json-only', 'html', 'file'],
  'team-orchestration': ['member-system', 'review-protocol', 'upstream-header', 'operation-header', 'history-assistant-prefix',
    'op-parallel-aggregate', 'op-debate-work', 'op-debate-aggregate', 'op-review-revise', 'op-review-verdict'],
};

const BLOCK = /^###\s+block:\s*([a-z0-9-]+)\s*\r?\n```[a-z]*\r?\n([\s\S]*?)\r?\n```/gim;

export function parseSkill(source: string, file: string): Skill {
  const text = source.replace(/^\uFEFF/, '');
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta: Record<string, string> = {};
  for (const line of (front?.[1] ?? '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim();
  }
  const name = meta.name || path.basename(path.dirname(file));
  const blocks: Record<string, string> = {};
  for (const match of text.matchAll(BLOCK)) {
    if (Object.hasOwn(blocks, match[1])) throw new Error(`Skill ${name}: duplicate block "${match[1]}"`);
    blocks[match[1]] = match[2].replace(/\r\n/g, '\n');
  }
  return { name, version: meta.version || '0', description: meta.description || '', path: file,
    sha256: createHash('sha256').update(text).digest('hex'), blocks };
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  lastError: string | null = null;

  constructor(private readonly dir: string, private readonly log: (message: string) => void = () => {}) {}

  /** Load every skill and check required blocks; throws on the first invalid state. */
  load(): void {
    if (!existsSync(this.dir)) throw new Error(`Skills directory not found: ${this.dir}`);
    const next = new Map<string, Skill>();
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.dir, entry.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const skill = parseSkill(readFileSync(file, 'utf8'), file);
      next.set(skill.name, skill);
    }
    for (const [name, blocks] of Object.entries(REQUIRED_BLOCKS)) {
      const skill = next.get(name);
      if (!skill) throw new Error(`Required skill "${name}" is missing from ${this.dir}`);
      const missing = blocks.filter(block => !skill.blocks[block]?.trim());
      if (missing.length) throw new Error(`Skill "${name}" is missing block(s): ${missing.join(', ')}`);
    }
    this.skills = next;
    this.lastError = null;
  }

  /** Reload on change. A broken edit keeps the last good skills and reports the error. */
  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dir, { recursive: true }, () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          try {
            this.load();
            this.log('skills reloaded');
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.log(`skills reload rejected, keeping previous version: ${this.lastError}`);
          }
        }, 150);
      });
    } catch (error) {
      this.log(`skills watch unavailable (${error instanceof Error ? error.message : error}); restart to pick up edits`);
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
  }

  block(skill: string, block: string): string {
    const value = this.skills.get(skill)?.blocks[block];
    if (value === undefined) throw new Error(`Skill block ${skill}/${block} is not loaded`);
    return value;
  }

  list(): Array<Omit<Skill, 'blocks'> & { blocks: string[] }> {
    return [...this.skills.values()].map(({ blocks, ...rest }) => ({ ...rest, blocks: Object.keys(blocks) }));
  }
}

/** Replace {{name}} placeholders; unknown placeholders are left visible rather than dropped. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? values[key] : whole));
}
