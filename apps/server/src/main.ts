import { createServer } from 'node:http';
import { loadConfig } from './config';
import { RuntimeRegistry } from './runtimes/registry';
import { SkillRegistry } from './skills';
import { createApi, VERSION } from './api';
import { staticHandler } from './static';

const log = (message: string) => console.log(`[awwo] ${message}`);

async function main(): Promise<void> {
  const config = loadConfig();
  const skills = new SkillRegistry(config.skillsDir, log);
  skills.load();
  skills.watch();
  const registry = new RuntimeRegistry({ file: config.runtimesFile, probeIntervalMs: config.probeIntervalMs, log });
  await registry.start();
  const api = createApi(config, registry, skills, log);
  const web = staticHandler(config.webDist);
  const server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (web && pathname !== '/api' && !pathname.startsWith('/api/')) return web(req, res);
    api.handle(req, res);
  });
  server.listen(config.port, config.host, () => {
    log(`AwwO Canvas orchestrator ${VERSION} on http://${config.host}:${config.port}`);
    log(web ? `web canvas: http://${config.host}:${config.port}/` : 'web canvas not built (npm run build); use the dev server on :5173');
    log(`skills: ${skills.list().map(skill => `${skill.name}@${skill.version}`).join(', ')}`);
    for (const runtime of registry.list()) log(`runtime ${runtime.id}: ${runtime.status}${runtime.error ? ` (${runtime.error})` : ''}`);
    if (config.apiToken) log('bearer token required on /api');
  });
  const shutdown = () => {
    log('shutting down');
    api.graphRuns.cancelAll();
    registry.stop();
    skills.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error(`[awwo] failed to start: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
