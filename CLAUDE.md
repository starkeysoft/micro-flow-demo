# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A set of browser demos for the [`@ronaldroe/micro-flow`](https://www.npmjs.com/package/@ronaldroe/micro-flow) workflow library, pinned to **3.1.1**. Every demo runs its micro-flow workflow entirely in the browser. The Express server only serves HTML pages and static assets. There is no test suite or linter (`npm test` is the default npm placeholder and always fails).

## Commands

- `npm install`, then `npm start`: runs `node server.js` on http://localhost:8081
- `npx nodemon server.js`: the same, but restarts when server-side `.js` files change (`nodemon` is a dev dependency)
- `docker compose up --build`: runs `nodemon` in a container and maps host port **8082** to container port 8081. The image copies the source at build time, so code changes need a rebuild.

The project is ESM (`"type": "module"`) and uses Express 5.

## Architecture

**Routing** (`server.js`): every `pages/<name>.html` is served at `/<name>`, and `pages/index.html` at `/`. Routes are registered from a directory scan at startup, so restart the server after adding a page. Everything under `public/` is served statically at the root (`/css/...`, `/js/...`).

**How pages load micro-flow**: micro-flow is published as unbundled ESM that imports Node's `crypto` and `node-schedule`, and `node-schedule` requires Node's `events`. A browser can't load that straight from `node_modules`. At startup, `lib/bundle-micro-flow.js` runs esbuild to build a single browser ESM bundle in memory, and the server serves it at `/vendor/micro-flow.js`. In that bundle:
- `crypto` is replaced by `lib/crypto-shim.js`. It falls back to `getRandomValues` because browsers only expose `crypto.randomUUID` over HTTPS or localhost, and the demos are often opened by LAN IP.
- `events` resolves to the `events` npm polyfill.

Each page declares an import map (`"micro-flow": "/vendor/micro-flow.js"`), so demo scripts use `import { ... } from 'micro-flow'`. To upgrade micro-flow, change its exact version in `package.json`. If the new version adds imports that only exist in Node, esbuild fails at server startup.

**Adding a demo**: create `pages/<name>.html` and `public/js/<name>.js`, and add a link card to `pages/index.html`. That list is maintained by hand. Every demo shares the same visual design and **must include the status panel** in the top right.
- Copy the `<head>` (stylesheet link and import map) and the `.status-panel` markup from an existing page, and load the demo script with `<script type="module">`.
- `public/css/demo.css` holds the shared styles: dark page, uppercase `h1`, `.arena`, `.box` / `.box.flash`, `.button`, and the status panel classes (`.status-panel`, `.step-type-badge`, `.stat-row`, `.counter`). Put styles for a single demo in `public/css/<name>.css`.
- `public/js/status-panel.js` exports `createStatusPanel(step_types)`, which returns a `status(stepName, callableText, badge?)` function. `step_types` links step names to badge labels (e.g. `'LoopStep › for'`); an explicit `badge` argument takes priority. Update the map when you add or rename steps, or the badge falls back to "Step".

**box-tour demo** (`public/js/box-tour.js`): this is the original server-driven demo, ported to run in the browser.
- `buildWorkflow()` creates a **new** `Workflow` for each lap, and `run()` executes it in a `while (true)` loop.
- In v3 each workflow gets its own state, and the `State` singleton is deprecated. The lap count is therefore a module-level variable, which the `ConditionalStep` reads through a function `subject`.

**pokemon-party demo** (`public/js/pokemon-party.js`): each click on the refresh button (and the initial page load) builds and runs a new workflow that fetches 6 random Pokémon from PokeAPI (`https://pokeapi.co/api/v2`, CORS-enabled, no key) into CSS flip cards. The species count is fetched once and cached in a module variable. Fetch errors are caught in the callables, and the card shows an error state instead of failing the workflow.

**launch-control demo** (`public/js/launch-control.js`, with `launch-feed.js` and `launch-observer.js`): a rocket launch that exercises most of the library: `SwitchStep`/`Case` (one Case's callable is a `DelayStep`), `FlowControlStep` break and skip, `while`/`for_each`/`generator` loops, a relative and an absolute `DelayStep`, retries, `max_timeout_ms`, `exit_on_error`, a nested `Workflow` as a Step callable, and pause/resume.
- **Event-driven UI:** the timeline, log and status panel are built from `Workflow.events.step/.workflow` events by `createFeed()` in `launch-feed.js`, not from calls in the callables. Callables only call `feed.note(text)`.
- **Observer tab:** `/launch-observer` runs no workflow. It feeds the same `createFeed()` from `onBroadcast()`, because micro-flow posts every event to a `BroadcastChannel` named after it. It filters out other demos' events by workflow name / `parent_workflow_id`. Because the timeline is seeded from `workflow_running`, an observer that opens mid-launch first emits a custom `launch_snapshot_request` event; the mission tab answers with `launch_snapshot` (its serialized workflow). `emit()` broadcasts any event name, not only built-in ones.
- **Checkpoints:** `result_per_step_function` saves `{ workflow: serialized, state }` to `localStorage` after every step. Every function (callables, condition subjects, the switch subject, the checkpoint saver itself) is a named function registered in one `CallableRegistry`. The subjects read the module-level `mission`, so they need no closure over a particular workflow, and `Workflow.hydrate()` restores them all by name. After hydrating, the saved state is written back with `setState` and the status is set to `paused`, so `resume()` continues after the last saved step.

**robot-builder demo** (`public/js/robot-builder.js` + `public/js/robot-editor.js`): the robot's program is one live `Workflow`. It is edited in place and re-executed on every Run; each run adds to `program.sessions`, which the Runs panel lists.
- **Editor:** structural edits call the step API directly (`addStep`, `addStepAtIndex`, `moveStep`, `deleteStepByIndex`, `clearSteps`). Setting edits go through `ops` (`iterations`, `setConditional`, `SwitchStep.subject`, `cases`). A `WeakMap` (`meta`) links each step to its block settings and body workflows.
- **Nesting:** `repeat` / `repeat while` / `if` / `switch` run nested body `Workflow`s as callables. A bonk (or Stop) throws, and the failure propagates up through every enclosing step to the program.
- **What the demo code does:** actions and sensor functions only. Condition subjects are unregistered sensor closures, so saving and share links (`#p=`) use the demo's own block JSON, not `serialize()`.
- **Body `sessions` are cleared after each run** (a `workflow_complete` / `workflow_failed` listener). Otherwise every snapshot of a body embeds all of its earlier runs, and a long maze run overflows `JSON.stringify` inside `emit()`.
- **Needs micro-flow ≥ 3.1.0:** workflow reruns, per-run timeouts and nested failures that propagate. On 3.0.0 every program fails at the second pass of its first loop.

**robot-pathfinder demo** (`public/js/robot-pathfinder.js`, styles layered on `robot-builder.css`): seeded random layouts (maze, caves or open field; xmur3 + mulberry32, seed and layout in the URL hash) that the robot solves with A*.
- **A* runs as micro-flow steps:** the `a-star-search` `while` loop expands one node per pass, and the heuristic is chosen by a `SwitchStep`.
- **Structure:** `pathfinder-mission` loops `until-arrived` over a nested `plan-and-drive` workflow: scan → pick-heuristic → a-star-search → path-found? (then: a `drive` workflow; else: unreachable).
- **Surprise walls:** walls that drop onto the path make `follow-path` stop early. `until-arrived` then re-runs `plan-and-drive` from the robot's position.
- **Session cleanup:** as in robot-builder, nested bodies clear their `sessions` after each run.

**micro-flow 3.1.x behaviour the demos depend on:**
- Inside a `LoopStep` callable, `this` is the step instance, so these must be `function` expressions, not arrow functions. `this.results.length` gives the iteration number (loop results reset on every run).
- A `DelayStep` has no callable. To show its status, put a plain `Step` right before it (`announce-pause-*` in box-tour), and have that step report the DelayStep's name so the badge reads "DelayStep".
- A `for_each` `LoopStep` calls a function `iterable` when the loop starts, so it can read data from earlier steps (`iterable: () => picked_ids` in pokemon-party). Inside the callable, the current item is `this.current_item`.
- **Workflows and steps can run again.** Each `execute()` adds an entry to `sessions`, and the timeout restarts on each run. `max_timeout_ms` works on every step type.
- **Nested failures propagate:** a failed nested `Workflow` (or `Step`) callable fails the step that ran it.
- **Serialization:** function-valued condition subjects and values, `SwitchStep.subject`, function iterables and `result_per_step_function` are saved **by function name** (`conditional_callables`, `subject_callable`, `iterable_callable`) and resolved from the `CallableRegistry` on hydrate. Unnamed or unregistered functions come back `null`, with a console warning.
- **Instance state is never serialized, by design.** `setState` data is runtime-only. Anything a restored workflow needs must be saved alongside `serialize()` and written back with `setState` after hydrating (launch-control's checkpoints do this).
- **`sessions` grow without limit** and are embedded in every snapshot of a workflow (loop and step results, event payloads). A workflow run many times as a nested body should have its `sessions` cleared, and emitted snapshots should leave out `sessions`/`results`.
- **Events:** retries emit `step_retrying` (with `retry_count`). `workflow_paused` fires once, when the workflow has stopped. `workflow_step_skipped` and `workflow_break_executed` carry `{ workflow, step }`.
- micro-flow writes every step event to the browser console. The only way to turn this off is the deprecated `State.set('log_suppress', true)`.

## Git

Commit messages must not mention Claude, AI or any assistant. No `Co-Authored-By` trailer, no "Generated with" line, just a plain description of the change.
