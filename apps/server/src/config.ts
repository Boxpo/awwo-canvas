import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Repository root (apps/server/src → ../../..). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

export interface ServerConfig {
  host: string;
  port: number;
  runtimesFile: string;
  skillsDir: string;
  /** Built web canvas served on the orchestrator port when it exists. */
  webDist: string;
  /** Preferred runtime when a node selects none ('' = runtimes.json defaultRuntime, then first ready). */
  defaultRuntime: string;
  plannerRuntime: string;
  plannerModel: string;
  routerRuntime: string;
  routerModel: string;
  /** Browser origins allowed to send writes. */
  webOrigins: string[];
  /** Bearer token required on /api when set (mandatory for a non-loopback bind). */
  apiToken: string;
  probeIntervalMs: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.AWWO_HOST || '127.0.0.1';
  const port = Number(env.AWWO_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AWWO_PORT must be a TCP port');
  const apiToken = env.AWWO_API_TOKEN || '';
  // The orchestrator can spend model credentials through its workers. Exposing it beyond this
  // machine without authentication would hand that ability to the network.
  if (!isLoopback(host) && !apiToken) throw new Error(`Refusing to bind ${host} without AWWO_API_TOKEN`);
  const resolve = (value: string | undefined, fallback: string) => path.resolve(REPO_ROOT, value || fallback);
  const webOrigins = (env.AWWO_WEB_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',').map(origin => origin.trim()).filter(Boolean);
  return {
    host, port, apiToken, webOrigins,
    runtimesFile: resolve(env.AWWO_RUNTIMES_FILE, 'runtimes.json'),
    skillsDir: resolve(env.AWWO_SKILLS_DIR, 'skills'),
    webDist: resolve(env.AWWO_WEB_DIST, 'apps/web/dist'),
    defaultRuntime: env.AWWO_DEFAULT_RUNTIME || '',
    plannerRuntime: env.AWWO_PLANNER_RUNTIME || '',
    plannerModel: env.AWWO_PLANNER_MODEL || '',
    routerRuntime: env.AWWO_ROUTER_RUNTIME || '',
    routerModel: env.AWWO_ROUTER_MODEL || '',
    probeIntervalMs: Number(env.AWWO_PROBE_INTERVAL_MS || 10_000),
  };
}
