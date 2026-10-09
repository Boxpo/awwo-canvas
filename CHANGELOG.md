# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-09

First public release: the open-source edition of AwwO's agent canvas.

- Canvas framework (`@awwo/core`): document model, typed ports and wires, input/output contracts,
  the version-1 plan protocol, graph execution, review graphs and node teams, with AwwO's tests.
- Web canvas: infinite canvas, node inspector with per-node chat, graph runs that resume after a
  reload, the canvas assistant (plan or execute), hot-plug runtime panel, English and Chinese UI.
- Orchestrator: assistant router, streamed planner, graph runs with admission-time freezing,
  review loops, node teams, direct tasks and the hot-plug runtime registry.
- Orchestration skills: canvas-planner, assistant-router, node-delivery, team-orchestration,
  reloaded when edited.
- Reference workers: offline mock, OpenAI-compatible, minimal Python.
- `npm run smoke`: offline end-to-end check of the whole stack.
