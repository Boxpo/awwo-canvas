#!/usr/bin/env node
// One command for the whole local stack:
//   mock worker (:8791) + orchestrator (:8787) + web canvas (:5173)
//   + the OpenAI-compatible worker (:8792) when AWWO_OPENAI_API_KEY or OPENAI_API_KEY is set.
// Every process binds to 127.0.0.1. Ctrl+C stops all of them.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
if (!existsSync(path.join(root, 'node_modules'))) {
  console.error('Dependencies are missing. Run `npm install` in the repository root first.');
  process.exit(1);
}

const windows = process.platform === 'win32';
const children = [];
let stopping = false;

function start(name, command, args, env = {}) {
  // npm is a .cmd shim on Windows, which Node only starts through a shell. Arguments are fixed.
  const child = spawn(command, args, {
    cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    shell: windows && command === 'npm', windowsHide: true,
  });
  const prefix = `[${name}]`.padEnd(9);
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`);
    });
  }
  child.on('exit', code => {
    console.log(`${prefix} exited${code === null ? '' : ` with code ${code}`}`);
    if (!stopping) stop(code ?? 1);
  });
  children.push(child);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    // A shell-started npm leaves its grandchildren behind unless the whole tree is ended.
    if (windows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

start('mock', process.execPath, ['workers/mock/worker.mjs']);
if (process.env.AWWO_OPENAI_API_KEY || process.env.OPENAI_API_KEY) {
  start('openai', process.execPath, ['workers/openai-compatible/worker.mjs']);
} else {
  console.log('[dev]     OpenAI-compatible worker skipped (set AWWO_OPENAI_API_KEY to start it; the mock runtime works offline)');
}
start('server', 'npm', ['run', 'dev', '-w', '@awwo/server']);
start('web', 'npm', ['run', 'dev', '-w', '@awwo/web']);
console.log('[dev]     canvas: http://127.0.0.1:5173  ·  orchestrator: http://127.0.0.1:8787/api/health');
