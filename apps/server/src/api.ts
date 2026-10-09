import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail, guard, HttpError, openSse, readJson, Router, sendJson, type GuardOptions } from './http';
import type { ServerConfig } from './config';
import type { RuntimeRegistry } from './runtimes/registry';
import type { SkillRegistry } from './skills';
import { AdmissionError } from './orchestration/execution';
import { GraphRunManager } from './orchestration/graphRuns';
import { streamPlan } from './orchestration/planner';
import { routeAssistantMessage } from './orchestration/router';
import { streamDirectRun } from './orchestration/directRuns';

export const VERSION = '0.1.0';

export interface Api {
  handle(req: IncomingMessage, res: ServerResponse): void;
  graphRuns: GraphRunManager;
}

export function createApi(config: ServerConfig, registry: RuntimeRegistry, skills: SkillRegistry, log: (message: string) => void): Api {
  const defaultRuntime = () => registry.defaultRuntime(config.defaultRuntime);
  const graphRuns = new GraphRunManager({ registry, skills, defaultRuntime, log });
  const router = new Router();
  const hostNames = config.host === '0.0.0.0' || config.host === '::' ? [] : [config.host, 'localhost', '127.0.0.1', '[::1]'];
  const guardOptions: GuardOptions = {
    origins: new Set([...config.webOrigins, `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]),
    hosts: new Set(hostNames.map(host => `${host}:${config.port}`)),
    token: config.apiToken,
  };

  router.add('GET', '/api/health', (_req, res) => {
    sendJson(res, 200, { ok: true, version: VERSION, runtimes: registry.list().filter(item => item.status === 'ready').length,
      defaultRuntime: defaultRuntime(), skillsError: skills.lastError });
  });

  // ---- hot-plug runtimes -----------------------------------------------------------------
  router.add('GET', '/api/runtimes', (_req, res) => sendJson(res, 200, { items: registry.list(), defaultRuntime: defaultRuntime() }));
  router.add('POST', '/api/runtimes', async (req, res) => {
    const body = await readJson(req, 16 * 1024) as Record<string, unknown> | null;
    try {
      const view = await registry.register({ id: String(body?.id ?? ''), url: String(body?.url ?? ''),
        ...(typeof body?.label === 'string' ? { label: body.label } : {}), ...(typeof body?.token === 'string' ? { token: body.token } : {}) });
      sendJson(res, 201, { runtime: view });
    } catch (error) {
      fail(res, error instanceof Error && /runtimes\.json/.test(error.message) ? 409 : 400, 'invalid_runtime', error instanceof Error ? error.message : String(error));
    }
  });
  router.add('DELETE', '/api/runtimes/:id', (_req, res, params) => {
    try {
      if (!registry.unregister(params.id)) return fail(res, 404, 'not_found', 'Runtime not registered');
      sendJson(res, 200, { removed: params.id });
    } catch (error) {
      fail(res, 409, 'runtime_from_file', error instanceof Error ? error.message : String(error));
    }
  });
  router.add('POST', '/api/runtimes/:id/probe', async (_req, res, params) => {
    if (!registry.view(params.id)) return fail(res, 404, 'not_found', 'Runtime not registered');
    await registry.probe(params.id);
    sendJson(res, 200, { runtime: registry.view(params.id) });
  });
  // Catalog in the shape AwwO's node-team editor reads (model ids, effort levels, labels).
  router.add('GET', '/api/runtimes/:id/models', (_req, res, params) => {
    const view = registry.view(params.id);
    if (!view) return fail(res, 404, 'not_found', 'Runtime not registered');
    if (view.status !== 'ready') return fail(res, 503, 'runtime_unavailable', view.error ?? 'Runtime unavailable');
    sendJson(res, 200, {
      models: view.models.map(model => model.id),
      model_capabilities: Object.fromEntries(view.models.map(model => [model.id, { effort_levels: model.reasoningEfforts }])),
      model_labels: Object.fromEntries(view.models.map(model => [model.id, model.label])),
      tools: view.tools,
    });
  });

  // ---- orchestration skills --------------------------------------------------------------
  router.add('GET', '/api/skills', (_req, res) => sendJson(res, 200, { items: skills.list(), error: skills.lastError }));

  // ---- the canvas assistant --------------------------------------------------------------
  router.add('POST', '/api/assistant/route', async (req, res) => {
    const body = await readJson(req, 64 * 1024);
    sendJson(res, 200, await routeAssistantMessage(body, { registry, skills, routerRuntime: config.routerRuntime || config.plannerRuntime, routerModel: config.routerModel, log }));
  });
  router.add('POST', '/api/plan', async (req, res) => {
    const body = await readJson(req, 400 * 1024) as Record<string, unknown> | null;
    const sse = openSse(req, res);
    await streamPlan(body ?? {}, { registry, skills, plannerRuntime: config.plannerRuntime, plannerModel: config.plannerModel }, sse);
  });
  router.add('POST', '/api/runs', async (req, res) => {
    const body = await readJson(req, 4 * 1024 * 1024) as Record<string, unknown> | null;
    const sse = openSse(req, res);
    await streamDirectRun(body ?? {}, { registry, skills, defaultRuntime: defaultRuntime() }, sse);
  });

  // ---- graph runs ------------------------------------------------------------------------
  router.add('POST', '/api/graph-runs', async (req, res) => {
    const body = await readJson(req, 8 * 1024 * 1024) as Record<string, unknown> | null;
    try {
      const { run, created } = await graphRuns.create({ document: body?.document, scope: body?.scope, operationId: body?.operationId });
      sendJson(res, created ? 202 : 200, { run });
    } catch (error) {
      if (error instanceof AdmissionError) return fail(res, error.status, error.code, error.message);
      throw error;
    }
  });
  router.add('GET', '/api/graph-runs', (_req, res) => sendJson(res, 200, { items: graphRuns.list() }));
  router.add('GET', '/api/graph-runs/:id', (_req, res, params) => {
    const run = graphRuns.get(params.id);
    return run ? sendJson(res, 200, { run }) : fail(res, 404, 'not_found', 'Graph run not found');
  });
  router.add('POST', '/api/graph-runs/:id/cancel', (_req, res, params) => {
    const run = graphRuns.cancel(params.id);
    return run ? sendJson(res, 200, { run }) : fail(res, 404, 'not_found', 'Graph run not found');
  });
  router.add('GET', '/api/graph-runs/:id/events', (req, res, params, url) => {
    if (!graphRuns.get(params.id)) return fail(res, 404, 'not_found', 'Graph run not found');
    const header = Number(req.headers['last-event-id']);
    const after = Number.isFinite(header) && header > 0 ? header : Math.max(0, Number(url.searchParams.get('after')) || 0);
    const sse = openSse(req, res);
    const unsubscribe = graphRuns.subscribe(params.id, after, event => {
      sse.send(event, { id: event.seq });
      if (event.type === 'status' && ['completed', 'failed', 'cancelled'].includes(event.status)) setImmediate(() => sse.close());
    });
    sse.signal.addEventListener('abort', () => unsubscribe?.());
    if (graphRuns.terminal(params.id)) setImmediate(() => sse.close());
  });

  return {
    graphRuns,
    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://orchestrator.local');
      const blocked = guard(req, url, guardOptions);
      if (blocked) return fail(res, blocked.status, blocked.code, blocked.message);
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (matched === null) return fail(res, 404, 'not_found', 'Unknown endpoint');
      if (matched === 'method') return fail(res, 405, 'method_not_allowed', 'Method not allowed');
      Promise.resolve(matched.handler(req, res, matched.params, url)).catch(error => {
        if (error instanceof HttpError) return fail(res, error.status, error.code, error.message);
        log(`unhandled ${req.method} ${url.pathname}: ${error instanceof Error ? error.stack : error}`);
        if (!res.headersSent) fail(res, 500, 'internal_error', 'Internal error');
        else res.end();
      });
    },
  };
}
