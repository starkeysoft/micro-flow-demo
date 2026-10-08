# micro-flow demos

Interactive browser demos for [micro-flow](https://www.npmjs.com/package/@ronaldroe/micro-flow), a lightweight workflow orchestration library. Each demo runs its micro-flow workflow entirely in the browser. The small Express server only serves the pages, and bundles micro-flow for the browser at startup.

The demos use micro-flow **3.1.1**.

## Running the demos

You need [Node.js](https://nodejs.org/) 24 or newer.

```sh
npm install
npm start
```

Then open http://localhost:8081. The index page links to every demo.

To have the server restart when you change server-side code:

```sh
npx nodemon server.js
```

### With Docker

```sh
docker compose up --build
```

Then open http://localhost:8082. The container runs `npm start` and copies the source when the image is built, so run `docker compose up --build` again after changing any files.

## Deploying (Tailscale Funnel)

The backend demos need a long-running Node process, so the demos are hosted from your own machine and exposed to the public internet with [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). It's free, needs no domain, and makes only outbound connections, so you don't need to open any ports. The site is served at `https://micro-flow.<your-tailnet>.ts.net`.

One-time setup in the [Tailscale admin console](https://login.tailscale.com/admin):

1. **DNS:** make sure MagicDNS is on and enable **HTTPS Certificates**. Rename the tailnet first if you want a friendlier URL.
2. **Access controls:** add a tag and let it use Funnel:

   ```json
   "tagOwners": { "tag:container": ["autogroup:admin"] },
   "nodeAttrs": [{ "target": ["tag:container"], "attr": ["funnel"] }],
   ```

3. **Settings → Keys:** generate a reusable auth key tagged `tag:container`.
4. Copy `.env.example` to `.env` and paste in the key: `TS_AUTHKEY=tskey-auth-...`. `.env` is git-ignored.

Then start the app and Funnel:

```sh
docker compose --profile funnel up -d --build
docker compose exec tailscale tailscale funnel status
```

The second command prints the public URL. Plain `docker compose up` still runs only the app. Both containers restart automatically, including after a reboot. The Tailscale login is kept in the `tailscale-state` volume, so the auth key is only used the first time. `tailscale/serve.json` sends public port 443 to the app.

Things to know:

- The site is up only while your machine and the containers are running.
- Backend jobs are kept in memory, so a restart clears them.
- The job limits are shared by every visitor, not set per visitor.
- link-checker blocks private and loopback addresses, so the public site can't be used to probe your local network.

## The demos

Every demo has a **Workflow Status** panel in the top right that shows the step that's running, its type and what it's doing. On a phone or a narrow window it becomes a bar fixed to the bottom of the screen.

The first seven demos run their workflows in your browser. **link-checker** and **job-scheduler** run theirs on the server: the page calls the server's API, and a second **Server Status** panel (bottom right) streams the server's workflow events live.

### box-tour (`/box-tour`)

A box moves around the edge of the arena in a loop, driven by `Step`, `LoopStep`, `DelayStep` and `ConditionalStep`. From the second lap on, a conditional step makes the box flash. There's nothing to set; just watch.

### pokemon-party (`/pokemon-party`)

Fetches six random Pokémon from the public [PokeAPI](https://pokeapi.co/) and shows them as cards. Hover over a card (or focus it, or tap it on a touch screen) to flip it and see its types, base stats, height and weight. **Draw a new party** picks six more. It needs an internet connection.

### launch-control (`/launch-control`)

A rocket launch that uses nearly all of micro-flow: a switch with cases, break and skip steps, `while`, `for_each` and generator loops, retries, timeouts, a nested workflow, pause and resume, and the event bus.

- **Launch** starts the countdown. **Pause** stops at the next step boundary, then becomes **Resume**. **Reset** clears everything.
- **Chaos** sets how often system checks fail (they retry up to 3 times) and how slow the range-safety handshake gets (it times out after 1.5 s). A failure that runs out of retries aborts the launch.
- **Weather** picks clear, windy (a 2.5 s hold) or storm (the launch is scrubbed), or **Auto** for a random draw.
- **Fast-track** skips the built-in 3 s hold.
- The **Step timeline** and **Event log** are built from micro-flow's events as the launch runs.
- **Checkpoints:** progress is saved in the browser after every step. Reload the page mid-launch and a banner offers to resume from the last completed step.
- **Open observer tab ↗** opens `/launch-observer`, which runs no workflow of its own. It mirrors the launch from another tab using micro-flow's cross-tab broadcasts, and catches up if you open it mid-launch.

### robot-builder (`/robot-builder`)

Program a robot to reach the goal by building its program from blocks. The program is a real micro-flow workflow, edited through its step API and run again each time you press **Run**.

- **Blocks:** move forward, turn left, turn right, paint, repeat N times, repeat while ⟨condition⟩, if / else, and switch on a sensor.
- **Conditions:** a sensor (`ahead`, `left`, `right`, `here`, `facing`, `moves`), an operator (`===`, `!==`, `in`, `not_in`, `<`, `>=`, `regex_match`, `string_starts_with`) and a value. For `in` and `not_in`, separate values with commas (for example `wall,painted`).
- **Editing:** add blocks with **+ add block…**. Each block has buttons to move it up or down, duplicate it or delete it. Blocks inside loops and branches edit the same way.
- **Level** switches between Hallway, Room lap and Maze. **Starter** loads a working program for the current level.
- Moving into a wall is a "bonk": the run fails, and the failed block and everything around it are marked. **Stop** ends a run early.
- **Runs** lists each run's time, moves and outcome. **Share** copies a link with your program in it. Your program is also saved in the browser automatically.
- **micro-flow JSON** shows what `serialize()` produces for your program.

### robot-pathfinder (`/robot-pathfinder`)

The robot finds its own way to the goal with the A* search algorithm, on a layout generated from a seed.

- **Seed:** type any text, or press ⟳ for a random one. The same seed and layout always make the same map, and both are kept in the URL, so you can share a map by sharing the link.
- **Layout:** Maze, Caves or Open field.
- **Heuristic:** Manhattan, Euclidean, or None (which makes the search Dijkstra's algorithm). Compare the **Nodes expanded** count on the same map.
- **Go** starts the robot: first you see the search spread across the map (frontier and visited cells), then the chosen path, then the robot drives it. **Speed** sets how fast both happen. **Stop** ends a run early.
- **Surprise walls** drop walls onto the path while the robot drives. When it hits one it stops and plans again from where it is. If the walls cut off the goal completely, the run ends as unreachable.
- The **Mission workflow** panel shows the workflow tree and highlights each step as it runs.

### flow-canvas (`/flow-canvas`)

An n8n-style visual editor: drag nodes onto a canvas, wire them together and press **Run**. The graph is compiled into a tree of real micro-flow workflows and executed in your browser.

- **Building:** drag a node from the palette onto the canvas (or click it to drop it in the middle). Drag from an output dot to another node to connect them. Drop a wire on empty space to pick a node to add and connect there, or double-click the canvas to add one. Drag a wire off an input dot to move or remove it. Drag the background to pan and scroll to zoom; **Fit** frames the whole flow.
- **Editing:** click a node to edit it in the inspector on the right, under the status panel. Every node has a name (its micro-flow step name) and, under **Settings**, retries (`max_retries`) and a timeout (`max_timeout_ms`). Delete or Backspace removes the selected node or wire.
- **Nodes and what they compile to:**
  - **Manual Trigger** (output JSON) starts the flow; the whole graph becomes one root `Workflow`.
  - **HTTP Request**, **Edit Fields**, **Transform**, **Random Number**, **Chaos Monkey** (fails some of the time) and **Display** (a card in the Output tab) are plain `Step`s.
  - **If** is a `ConditionalStep` with a true and a false branch, and offers every micro-flow comparison operator except `custom_function`.
  - **Switch** is a `SwitchStep` with one `Case` per output, plus a default.
  - **Loop Over Items** is a `for_each` `LoopStep` and **Repeat** is a `for` `LoopStep`. Each has an *each* branch and a *done* output that gets the list of results.
  - **Wait** is a relative `DelayStep`. **Stop If** and **Skip Next If** are `break` and `skip` `FlowControlStep`s; a Stop If inside a loop drops that item, like a filter.
  - Every branch is a nested `Workflow`. An output wired to several nodes runs each branch in turn.
- **Data:** each node gets the previous node's output. Text fields can use `{{ path }}` to read from it (for example `{{ types[0].type.name }}`), `{{ $item.x }}` for the current loop item and `{{ $trigger.x }}` for the trigger's output.
- **Running:** **Run** (or Ctrl/Cmd + Enter), **Pause** (takes effect after the current top-level step) then **Resume**, and **Stop**. Nodes light up as their steps run, packets travel along the wires, branch outputs flash when taken, and badges show run counts, loop passes, retries and times. **Stop on first error** sets `exit_on_error` on every workflow; turn it off and a failed step is logged and the flow carries on.
- **Tabs:** **Output** (Display cards), **Execution log** (micro-flow events), **Node data** (the selected node's last input and output), **Compiled micro-flow** (the generated workflow tree, including the small hidden helper steps around loops) and **serialize()**.
- **Templates:** Pokémon type sorter, Weather board, Dog gallery and Flaky API (retries and a filter). The first three call public APIs (PokeAPI, Open-Meteo, dog.ceo), so they need an internet connection.
- Your flow is saved in the browser automatically. **Share** copies a link with the flow in it, and **Clear** starts over.
- **On a phone or narrow window:** the palette becomes a menu bar of categories. Tap one to open its nodes, then tap a node to add it to the middle of the canvas. Touch works for dragging nodes and wires.

### diner-rush (`/diner-rush`)

A short kitchen shift where every ticket is its own micro-flow workflow, all running at the same time, and some steps can only finish when you click.

- Pick a shift length and press **Start shift**. Customers walk in faster as the shift goes on, and the doors close when the clock runs out (an absolute `DelayStep`). Open tickets still have to be finished.
- **Stations:** the grill and the fryer have two slots each and the shake machine has one. Items wait in line for a free slot.
- **Your jobs:** when a burger or fries are done, press **Plate it** or **Basket up** before the red bar runs out. That window is the step's `max_timeout_ms`. If you miss it, the step times out and micro-flow retries it once (**Save it!**), and the food comes out charred or soggy. Miss that too and the dish is ruined. When the shake machine jams, **Kick it** to clear the jam before the retry; otherwise it may jam again (up to 3 retries).
- **Patience:** each customer's patience is the `max_timeout_ms` of their ticket's cooking loop. If it runs out, they walk out.
- **Tickets:** a ticket shows each item, a patience bar and the workflow's progress (from `result_per_step_function`). **86 it** cancels a ticket. A reservation pauses its own workflow until you press **Seat them**, which resumes it. Now and then a customer adds a shake to a ticket that's already cooking, and the page inserts a new step into the running workflow.
- After cooking, a `ConditionalStep` adds a 30% tip if every item was perfect, and a `skip` `FlowControlStep` only offers pie to customers who are still happy.
- The **Kitchen feed** is built from micro-flow events, and the end-of-shift summary is read from each ticket's `sessions`.

### link-checker (`/link-checker`)

The server checks a list of URLs for you. Your browser can't read most sites directly because they don't allow cross-origin requests, but the server can.

- Enter up to 10 URLs, one per line (a sample list is filled in), and press **Check links**.
- The page sends the list to `POST /api/link-check`, then polls `GET /api/link-check/:id` and fills in the report as each URL finishes.
- Each row shows the result (`200`, a redirect such as `301→200`, `404`, `timeout`, `DNS`, `blocked` or `invalid`), how long it took, the final URL after redirects and the content type. The summary counts OK, redirected, broken and failed URLs.
- On the server, each URL is checked in its own step with one retry and a 5 s timeout per attempt. Loopback, private and link-local addresses are blocked, so the checker can't be used to probe your network.
- It needs an internet connection.

### job-scheduler (`/job-scheduler`)

Schedule jobs that run on the server at a set time.

- Pick a task: **Deliver a message**, **Roll 3d6**, or **Count primes** below a number (the counting happens on the server).
- Set **Run in** (5–120 s) and press **Schedule**. The job appears under **Waiting** with a countdown, then moves to **Done** with its result.
- The jobs live on the server: close the tab, come back later, and the results are there. Everyone who opens the page sees the same board.
- **clear** removes finished jobs. Jobs are kept in server memory, so restarting the server clears them.

## How it works

- `server.js` serves every `pages/<name>.html` at `/<name>` (and `pages/index.html` at `/`), plus the files in `public/`.
- micro-flow is published for Node, so at startup `lib/bundle-micro-flow.js` uses esbuild to bundle it into a single browser module, served at `/vendor/micro-flow.js`. Each page maps `micro-flow` to that file with an import map, so demo code uses `import { Workflow } from 'micro-flow'`.
- Shared styles are in `public/css/demo.css`, and the shared status panel code is in `public/js/status-panel.js`.
- Every demo works on a phone. Pages reflow to the screen width, and arenas whose contents are positioned in pixels are scaled down to fit by `public/js/fit-arena.js`.
- The server-side demos' API lives in `api/`. Their workflows use micro-flow straight from `node_modules`, and `api/server-status.js` streams their events to the page's Server Status panel over Server-Sent Events (`/api/server-status/stream?demo=…`).

## Adding a demo

1. Create `pages/<name>.html`. Copy the `<head>` (stylesheet link and import map) and the status panel markup from an existing page.
2. Put the demo's script in `public/js/<name>.js`, and any demo-specific styles in `public/css/<name>.css`.
3. Add a card for it to `pages/index.html`, keeping the cards in alphabetical order.
4. Restart the server, which registers routes when it starts, and describe the demo in this README.

## License

[MIT](LICENSE)
