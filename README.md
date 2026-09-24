# micro-flow demos

Interactive browser demos for [micro-flow](https://www.npmjs.com/package/@ronaldroe/micro-flow), a lightweight workflow orchestration library. Each demo runs its micro-flow workflow entirely in the browser. The small Express server only serves the pages, and bundles micro-flow for the browser at startup.

The demos use micro-flow **3.1.1**.

## Running the demos

You need [Node.js](https://nodejs.org/) 18 or newer.

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

Then open http://localhost:8082. The container copies the source when the image is built, so run `docker compose up --build` again after changing any files.

## The demos

Every demo has a **Workflow Status** panel in the top right that shows the step that's running, its type and what it's doing.

The first five demos run their workflows in your browser. **link-checker** and **job-scheduler** run theirs on the server: the page calls the server's API, and a second **Server Status** panel (bottom right) streams the server's workflow events live.

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
- The server-side demos' API lives in `api/`. Their workflows use micro-flow straight from `node_modules`, and `api/server-status.js` streams their events to the page's Server Status panel over Server-Sent Events (`/api/server-status/stream?demo=…`).

## Adding a demo

1. Create `pages/<name>.html`. Copy the `<head>` (stylesheet link and import map) and the status panel markup from an existing page.
2. Put the demo's script in `public/js/<name>.js`, and any demo-specific styles in `public/css/<name>.css`.
3. Add a card for it to `pages/index.html`.
4. Restart the server, which registers routes when it starts, and describe the demo in this README.

## License

[MIT](LICENSE)
