# micro-flow demos

Interactive browser demos for [micro-flow](https://www.npmjs.com/package/@ronaldroe/micro-flow), a lightweight workflow orchestration library. Most demos run their micro-flow workflows entirely in the browser. The backend demos (link-checker, job-scheduler, etl-pipeline, order-saga and webhook-inbox) run theirs on the Express server, which also serves the pages and bundles micro-flow for the browser at startup.

See the demos live, [here](https://micro-flow.softshell-sailfin.ts.net/).

The demos use micro-flow **4.0.0**.

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
- Backend jobs, the ETL warehouse, the saga's stock and the webhook inbox are kept in memory, so a restart clears them.
- The job limits are shared by every visitor, not set per visitor.
- link-checker blocks private and loopback addresses, so the public site can't be used to probe your local network.
- The webhook-inbox signing secret is public on purpose, so anyone can post signed test events to the receiver. Its queue and log are capped.

## The demos

Every demo has a **Workflow Status** panel in the top right that shows the step that's running, its type and what it's doing.

The first seven demos run their workflows in your browser. The backend demos (**link-checker**, **job-scheduler**, **etl-pipeline**, **order-saga** and **webhook-inbox**) run theirs on the server, the way you'd use micro-flow in a Node service: the page calls the server's API, and a second **Server Status** panel (bottom right) streams the server's workflow events live.

**On phones and tablets** the demos fit the screen width. The arenas scale down as a whole, and side-by-side panels stack. Below about 1200px wide the status panels move under the demo instead of covering it. On phones the Workflow Status panel becomes a bar pinned to the bottom of the screen that shows the current step. Tap it to see the full panel.

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
- **Never block the goal** (on by default, needs Surprise walls) only drops a surprise wall where there's still another way to the goal, so every run can finish. In a maze most corridors are the only way through, so you'll see fewer surprises there. Turn it off to let the walls trap the robot.
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

### etl-pipeline (`/etl-pipeline`)

A batch ETL job that runs on the server: extract a CSV, profile it, clean it, check its quality, then load it into a warehouse.

- Paste a CSV with `order_id,date,customer_email,country,amount,currency`, or pick a sample: **Messy orders** (mixed date formats, `$1,204.50` / `1.204,50` amounts, country names, bad rows and a duplicate), **Clean orders**, or **Broken header**.
- Set the **quality gate** (the share of rows that may be rejected, default 20%) and optionally turn on **Flaky warehouse**, which makes 35% of chunk writes fail. Then press **Run pipeline**.
- The six stage chips (extract → profile → transform → quality gate → load → report) light up as the server works through them. The page sends `POST /api/etl/runs` and polls `GET /api/etl/runs/:id`.
- **Profile** shows how full each column is, its distinct count and some sample values. **Dead letter** lists rejected rows with their line number and reason. **Loaded** shows the cleaned rows (ISO dates, ISO-2 countries, amounts converted to USD). **Load chunks** shows each 20-row chunk's attempts, including retries.
- If more rows are rejected than the gate allows, the run stops before loading anything. A header without the required columns fails at extract.
- Loading is an upsert keyed on `order_id`, so loading the same file again reports every row as unchanged. The **Warehouse** panel is shared by everyone: row count, revenue by country and the latest writes. **truncate** empties it. It holds up to 2,000 rows in server memory.

### order-saga (`/order-saga`)

Place an order that runs as a saga across five mock services on the server: orders, inventory, payments, shipping and email. Each step that succeeds records how to undo itself. If a later step fails, those undo steps run in reverse.

- Pick quantities, a test card and a shipping region, then press **Place order**. Card `4242…` succeeds, `4000…0119` hits two gateway timeouts and succeeds on the third try, and `4000…0002` is declined. No carrier ships to **Antarctica**.
- **Inject faults**: **Slow carrier** makes shipping time out after 2 s, **Orders DB down** fails the last step, so a captured payment is refunded and the shipment cancelled, **Email down** fails only the receipt (the order still goes through, with a warning), and **Inventory down during undo** makes a compensation fail, so the order ends as **needs attention**.
- The **Saga timeline** has a lane per service and adds each call as it happens: green for forward steps, blue for retries, red for errors and amber for compensations. A banner shows whether the order was confirmed, cancelled (and why) or needs attention.
- **Services** shows stock (on hand and reserved) and the payments ledger (held, captured, voided, refunded) plus shipments. Stock is shared by everyone, so it really runs out. **restock** refills it. **Recent orders** lists everyone's orders; click one to see its timeline.
- Orders are kept in server memory (the newest 30, at most 5 in flight), so a restart clears them.

### webhook-inbox (`/webhook-inbox`)

A webhook receiver running on the server. A fictional payment provider, Paystream, signs each event, and the server checks the signature, drops duplicates and processes the events in the background.

**How to use this demo**, at the top of the page, shows how a delivery flows from the console to the handlers, walks through seven scenarios in order (happy path, duplicates, forged and replayed requests, a burst, retries and the dead letter queue, partial failures, unknown events), and explains the colours in the log. On phones it starts collapsed; tap it to open.

- The **Paystream console** sends events: `order.created`, `payment.succeeded`, `payment.failed`, `customer.updated`, and `invoice.finalized`, which has no handler and is logged as unhandled. **Duplicate last** resends the last event with the same id. **Tampered** changes the body after signing it. **Stale** signs with a timestamp 10 minutes old. **Burst ×8** sends eight random events.
- The receiver (`POST /api/webhooks/receive`) checks the HMAC-SHA256 signature in the `paystream-signature` header (`t=<timestamp>,v1=<hex>`) and rejects timestamps more than 5 minutes off (401). It ignores event ids it has already seen (200, duplicate). Otherwise it answers 202 straight away and queues the event (at most 30, after that 429).
- **Workers**: two worker workflows drain the queue, and each event runs in its own workflow. A switch routes the event by type to its handlers, such as reserve-stock, send-confirmation and notify-slack. Each handler is retried twice with backoff.
- **CRM outage** makes `sync-crm` fail, and **Flaky email** makes about 40% of email sends fail. An event that still fails after its retries goes to **Dead letter**. **Redeliver** runs the same workflow again, and handlers that already succeeded are skipped.
- **Deliveries** lists every delivery with the receiver's response, its status and a chip per handler (colour shows the status, ×n shows the attempts). **clear finished** removes completed, ignored and rejected rows.
- The receiver is a real endpoint. Send your own event (the secret `whsec_demo_microflow` is public because this is a demo):

  ```sh
  SECRET=whsec_demo_microflow
  T=$(date +%s)
  BODY='{"id":"evt_curl_'$T'","type":"customer.updated","created":'$T',"data":{"customer":{"id":"cus_1","email":"ada@example.com"}}}'
  SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
  curl -i http://localhost:8081/api/webhooks/receive \
    -H 'content-type: application/json' \
    -H "paystream-signature: t=$T,v1=$SIG" \
    -d "$BODY"
  ```

- Everyone shares one inbox, and it is kept in server memory, so a restart clears it.

## How it works

- `server.js` serves every `pages/<name>.html` at `/<name>` (and `pages/index.html` at `/`), plus the files in `public/`.
- micro-flow is published for Node, so at startup `lib/bundle-micro-flow.js` uses esbuild to bundle it into a single browser module, served at `/vendor/micro-flow.js`. Each page maps `micro-flow` to that file with an import map, so demo code uses `import { Workflow } from 'micro-flow'`.
- Shared styles are in `public/css/demo.css`, and the shared status panel code is in `public/js/status-panel.js`. That code also makes the panel tappable on phones and calls `public/js/fit-arena.js`, which scales arenas marked `data-fit` down to the screen width with CSS `zoom`.
- The server-side demos' API lives in `api/`. Their workflows use micro-flow straight from `node_modules`, and `api/server-status.js` streams their events to the page's Server Status panel over Server-Sent Events (`/api/server-status/stream?demo=…`).

## Adding a demo

1. Create `pages/<name>.html`. Copy the `<head>` (stylesheet link and import map) and the status panel markup from an existing page. If the arena's contents are positioned in pixels inside the 640×400 box, add `data-fit` to the `.arena` element so it scales down on phones.
2. Put the demo's script in `public/js/<name>.js`, and any demo-specific styles in `public/css/<name>.css`.
3. Add a card for it to `pages/index.html`, keeping the cards in alphabetical order.
4. Restart the server, which registers routes when it starts, and describe the demo in this README.

## License

[MIT](LICENSE)
