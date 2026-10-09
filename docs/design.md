# Design

How AwwO Canvas is put together, and the rules each part keeps. The code is the reference; this
document explains why it is shaped the way it is. 中文版：[design.zh-CN.md](design.zh-CN.md).

## 1. The idea

A goal becomes a small graph of agents. Each node is one responsibility (clarify the goal, write
the page, build the backend, review the delivery) with a typed **contract**: the inputs it needs
and the outputs it must hand on. Wires carry outputs to inputs. The graph runs in dependency
order; a review graph loops until a reviewer approves or the round budget is spent.

Three things make that usable rather than a demo:

1. The **canvas document** is the single source of truth, edited by people and by the assistant
   through the same validated operations, and every change is one undo step.
2. **Orchestration is data.** Every prompt lives in `skills/*.md`, and the rules that are not
   prompts (routing, team order, review rounds, retries) are deterministic code.
3. **Engines are pluggable processes.** The orchestrator speaks one small protocol to workers and
   links no agent SDK, so an engine joins or leaves while everything runs.

## 2. The canvas document (`packages/core`)

`canvasDoc.ts` defines one JSON document: `nodes`, `edges`, `waypoints`, the last `view`, and an
optional `execution` policy.

- **Nodes** are `session` nodes (an agent with a persona, an optional runtime/model/effort, an
  optional team, and a contract) or `form` nodes (labelled values a person fills in).
- **Contracts** (`nodeContracts.ts`) declare input and output fields with a type: `text`,
  `markdown`, `html`, `number`, `boolean` or `file`. Ports are derived from them (`ports.ts`), and
  a wire is legal only between compatible types, with one source per single input.
- **Edges** are `data` (this run) or `feedback` (the previous review round's output; it may close a
  cycle, which data edges may not).
- **Outputs stay honest.** A node's `lastOutput` records where it came from (`run`, `manual`,
  `case`) and whether it is `partial` (text kept from a failed run is evidence, not a result).
  `invalidateOutputs.ts` clears every stored output that no longer holds after an edit: changing a
  node's settings clears it and its descendants, replacing an output clears its descendants, a
  rewired input clears its receiver. Layout changes clear nothing.

The browser keeps the document in `localStorage`. A payload that cannot be read is preserved under
a backup key before anything can overwrite it, so a bad write never silently becomes an empty canvas.

## 3. Planning: a closed protocol, validated twice

The assistant never edits the canvas directly. The planner returns a **proposal** in the version-1
protocol (`canvasPlan.ts`): eleven operation types (`add_node`, `update_node`, `set_input`,
`add_field`, `update_field`, `remove_field`, `remove_node`, `connect`, `set_edge_kind`,
`set_execution`, `disconnect`), unknown keys rejected, hard limits on every size.

1. The canvas builds the context (`planningContext.ts`): the protocol, planning guidance, the
   seven role templates, the **current structure** (no credentials, transcripts or outputs) and the
   last turns of the conversation as intent only.
2. The orchestrator makes one model call with the `canvas-planner` skill and streams progress made
   only of measurements (characters written, `add_node` and `connect` markers seen, reasoning
   size). It never shows a percentage, because nobody knows the final length.
3. The orchestrator extracts the JSON (a fenced block, even with a note after it) and checks it
   with the same `parseCanvasPlan` the canvas uses.
4. The canvas applies it with `applyCanvasPlan` on a private copy: references, type compatibility,
   single sources, data-edge cycles and the review policy are all checked, and only a complete
   success replaces the document, as **one** undo step. New nodes are laid out automatically.
5. If the canvas changed while the plan was being written (`canvasPlanRevision` fingerprint), the
   plan is reported stale instead of applied over the newer edits.
6. A malformed plan is retried exactly once. Runtime faults and cancellations are not retried: a
   loop on a broken model would only spend budget.

## 4. The assistant router: plan or execute

One conversation handles two kinds of message (`assistantRoute.ts`, `skills/assistant-router`):
`plan` arranges the canvas, `execute` does the task now with one agent. The client says which ways
it can carry out, the server narrows that to what is configured, routes explicit canvas-edit
wording by rule, otherwise asks a small model, and falls back to **plan** when it cannot tell: a
plan makes one call and is undone in one step, a task does real work. Every reply says how it was
routed, and the latest request can be handed to the other route with one click.

## 5. Graph runs (`apps/server/src/orchestration`)

The orchestrator, not the browser, owns a run.

- **Admission is strict and early.** The run receives a sanitized copy of the document. Preflight
  (`runGraph.ts`, `reviewGraph.ts`) checks required inputs, cycles, the review policy and teams.
  Then every node that may execute is **frozen**: its runtime and model are resolved against the
  live registry, its effort is checked against the model's catalog, its context budget computed.
  Any failure rejects the whole run before a single model call.
- **Frozen means frozen.** The skills text, runtime and model a node was admitted with are the ones
  it runs with, even if a worker is unplugged or a skill edited mid-run.
- **Scoped runs** execute only the selected nodes; an upstream outside the scope contributes its
  stored output and is reported `cached`, never `done`. An upstream with nothing stored blocks the
  node with a named reason rather than sending it an empty input.
- **Events are numbered.** Status, node, delta, team-turn, round and summary events form a log;
  the canvas follows it by sequence number, so a reload or a dropped stream resumes exactly.
- **Idempotent submission.** Each submission carries an `operationId`; resubmitting the same one
  returns the same run, and reusing it for a different graph is refused.
- **Writing results back** happens once, when the run has ended: fresh outputs go to their nodes,
  stale descendants are cleared, and the change is written into every undo snapshot instead of
  becoming an edit of its own, so undoing a move does not throw away a result.

## 6. Review graphs

`execution: { mode: 'review', maxRounds, reviewerNodeId, verdictFieldId }` turns a graph into a
loop. Each round runs the graph; `feedback` edges deliver the previous round's output; the final
reviewer's boolean verdict field decides: `true` approves, `false` runs another round, and the
round budget (1-5) bounds it. The canvas shows the round, and the summary says whether the graph
was approved or exhausted its rounds.

## 7. Node teams

A node can be a team of 1-8 members (`nodeTeam.ts`, `skills/team-orchestration`), executed
deterministically: the orchestrator decides order, visibility and stopping, never the model.

| Mode | Order and result | Planned calls |
| --- | --- | --- |
| sequential | each member once, in order; the last output is the result | N |
| parallel | N-1 members in parallel, the last aggregates; one failure stops the group | N |
| debate | R rounds of turns, then one summary by the last member | N x R + 1 |
| review | N-1 members produce or revise, the last reviews with a strict JSON verdict | at most N x R |

`maxTurns` is a hard cap on model calls and `timeoutSeconds` on the whole team. Member outputs are
data, never instructions. The team still delivers through the node's output contract.

## 8. Hot-plug runtimes

The protocol (`packages/core/src/protocol.ts`) is four endpoints: `GET /health`,
`POST /internal/runs` (an event stream), `DELETE /internal/runs/{runId}` and
`POST /internal/completions`. The registry (`apps/server/src/runtimes/registry.ts`):

- reads `runtimes.json` (watched) and accepts runtimes registered over the API, including workers
  that register themselves on start;
- probes each worker and validates its catalog: the runtime id it reports must match the id it is
  registered under, so a miswired URL cannot reroute calls; models declare input budgets (capped at
  256 KiB) and the reasoning-effort levels they accept;
- keeps worker URLs and tokens to itself: the browser sees ids, labels and catalogs only;
- never moves a running call: admission froze the runtime, and an unplugged worker fails the calls
  that were on it, visibly, instead of handing them to another engine.

A worker sends only a **count** of reasoning characters, never reasoning text, and a model that
returns only reasoning fails with `reasoning_only_output` rather than producing an empty result.

## 9. Skills as data

`skills/<name>/SKILL.md` holds frontmatter (`name`, `version`, `description`) and named blocks
(`### block: system` followed by a fenced block). `apps/server/src/skills.ts` loads them, hashes
them, reloads on change and refuses to start when a required block is missing. Tuning a prompt is
an edit, reviewed like code, with no wording hidden in the server.

## 10. What this edition leaves out

Accounts, billing, AwwO's hosted agents and marketplace, SSO, the desktop shell and production
deployment. What was changed from upstream, deliberately, is listed in [NOTICE.md](../NOTICE.md).
