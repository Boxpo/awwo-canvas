# Provenance

AwwO Canvas is the open-source edition of **AwwO**, the agent canvas built by ClawHunt Store.
It was cut from AwwO at upstream commit `9376e770` (2026-10-08) as a standalone repository: it
shares no git history with AwwO, and AwwO itself was not modified to produce it.

## Where each part comes from

| Path | Origin |
| --- | --- |
| `packages/core/src/` canvasDoc, ports, viewport, lod, spatialOrder, nodeContracts, htmlDeliverable, taskFrame, nodeThreads, invalidateOutputs, nodePresentation, wireState, runGraph, reviewGraph, reviewPartner, agentTemplates(.en), canvasPlan, locale | AwwO canvas modules, verbatim apart from the changes listed below |
| `packages/core/test/` | AwwO's own tests for those modules |
| `packages/core/src/` planningContext, assistantRoute, storage, protocol | extracted from AwwO's planning/routing client and its worker contract |
| `apps/web/src/canvas/` | AwwO canvas UI components and styles, verbatim apart from the changes listed below |
| `skills/*/SKILL.md` | prompt text from AwwO's control plane, moved into editable, hot-reloaded files |
| `apps/server/` | TypeScript port of the orchestration half of AwwO's Go control plane: runtime routing, node teams, graph runs, planner, assistant router |
| `workers/`, `apps/web/src/App.tsx` and the rest of `apps/web/src/` | new in this edition |

## Deliberate changes from upstream

- **Runtimes are open.** AwwO routes to a closed pair of engines (`pi`, `openai-agents`). Here a
  runtime is any worker registered with the orchestrator, so `nodeTeam.ts` validates runtime and
  tool ids by shape and `NodeTeamEditor.tsx` reads catalogs and tools from whichever runtime a
  member uses (`/api/runtimes/:id/models`).
- **No hosted agents.** AwwO nodes run only after they are bound to a hired agent on its control
  plane. Here a node runs directly on its runtime (`requireBinding: false`).
- **Neutral storage keys.** Browser storage keys use the `awwo.*` prefix instead of the internal
  product prefix they had upstream.

## Not included

Accounts, billing, the hosted agent workspace, marketplace, SSO, the desktop shell, AwwO's
production workers and its deployment configuration.
