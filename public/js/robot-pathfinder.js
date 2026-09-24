import {
  Workflow,
  Step,
  LoopStep,
  ConditionalStep,
  SwitchStep,
  Case,
} from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { badgeFor } from './launch-feed.js';

const COLS = 21;
const ROWS = 13;
const CELL = 28;
const ORIGIN_X = (640 - COLS * CELL) / 2;
const ORIGIN_Y = (400 - ROWS * CELL) / 2;
const ROBOT_SIZE = 22;
const START = { x: 1, y: 1 };
const GOAL = { x: COLS - 2, y: ROWS - 2 };
const VECTORS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N E S W
const LONG_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SURPRISES = 6;
const SURPRISE_CHANCE = 0.12;

const $ = (id) => document.getElementById(id);
const gridEl = $('grid');
const robotEl = $('robot');
const readoutEl = $('readout');
const goBtn = $('go');
const stopBtn = $('stop');
const seedEl = $('seed');
const layoutEl = $('layout');
const heuristicEl = $('heuristic');
const speedEl = $('speed');
const surpriseEl = $('surprise');
const planEl = $('plan');

const status = createStatusPanel();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const speed = () => Number(speedEl.value);
const key = (x, y) => `${x},${y}`;

// --- Seeded random numbers (xmur3 hash → mulberry32) ---
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rngFor = (seed, layout) => mulberry32(xmur3(`${layout}:${seed}`)());
const randomSeed = () => Math.random().toString(36).slice(2, 8);

// --- Layout generators (true = wall) ---
const filled = (value) => Array.from({ length: ROWS }, () => Array(COLS).fill(value));
const inside = (x, y) => x > 0 && y > 0 && x < COLS - 1 && y < ROWS - 1;

function border(grid) {
  for (let x = 0; x < COLS; x++) { grid[0][x] = true; grid[ROWS - 1][x] = true; }
  for (let y = 0; y < ROWS; y++) { grid[y][0] = true; grid[y][COLS - 1] = true; }
  return grid;
}

function reachable(grid) {
  const seen = new Set([key(START.x, START.y)]);
  const queue = [START];
  while (queue.length) {
    const { x, y } = queue.shift();
    if (x === GOAL.x && y === GOAL.y) return true;
    for (const [dx, dy] of VECTORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!grid[ny][nx] && !seen.has(key(nx, ny))) {
        seen.add(key(nx, ny));
        queue.push({ x: nx, y: ny });
      }
    }
  }
  return false;
}

function mazeLayout(rng) {
  const grid = filled(true);
  const stack = [[1, 1]];
  grid[1][1] = false;
  while (stack.length) {
    const [x, y] = stack.at(-1);
    const options = VECTORS
      .map(([dx, dy]) => [x + dx * 2, y + dy * 2, x + dx, y + dy])
      .filter(([nx, ny]) => inside(nx, ny) && grid[ny][nx]);
    if (!options.length) { stack.pop(); continue; }
    const [nx, ny, mx, my] = options[Math.floor(rng() * options.length)];
    grid[my][mx] = false;
    grid[ny][nx] = false;
    stack.push([nx, ny]);
  }
  // Knock out some walls between two open cells so there's more than one route.
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (!grid[y][x]) continue;
      const horizontal = !grid[y][x - 1] && !grid[y][x + 1] && grid[y - 1][x] && grid[y + 1][x];
      const vertical = !grid[y - 1][x] && !grid[y + 1][x] && grid[y][x - 1] && grid[y][x + 1];
      if ((horizontal || vertical) && rng() < 0.12) grid[y][x] = false;
    }
  }
  return grid;
}

function cavesLayout(rng) {
  let grid = border(filled(false).map((row, y) => row.map((_, x) => !inside(x, y) || rng() < 0.42)));
  for (let pass = 0; pass < 4; pass++) {
    grid = grid.map((row, y) => row.map((_, x) => {
      if (!inside(x, y)) return true;
      let walls = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && grid[y + dy][x + dx]) walls++;
      return walls >= 5;
    }));
  }
  return grid;
}

function fieldLayout(rng) {
  return border(filled(false).map((row, y) => row.map((_, x) => !inside(x, y) || rng() < 0.24)));
}

const GENERATORS = { maze: mazeLayout, caves: cavesLayout, field: fieldLayout };

function generate(seed, layout) {
  const rng = rngFor(seed, layout);
  for (let attempt = 0; attempt < 30; attempt++) {
    const grid = (GENERATORS[layout] ?? mazeLayout)(rng);
    grid[START.y][START.x] = false;
    grid[GOAL.y][GOAL.x] = false;
    if (reachable(grid)) return grid;
  }
  const grid = fieldLayout(rng);
  for (let x = 1; x < COLS - 1; x++) grid[START.y][x] = false; // guaranteed corridor
  for (let y = 1; y < ROWS - 1; y++) grid[y][GOAL.x] = false;
  return grid;
}

// --- World + robot ---
let grid = generate('demo', 'maze');
let cells = [];
let robot = { x: START.x, y: START.y, dir: 1 };

const isWall = (x, y) => grid[y]?.[x] ?? true;
const cellEl = (x, y) => cells[y * COLS + x];

function renderGrid() {
  gridEl.replaceChildren();
  cells = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = document.createElement('div');
      const goal = x === GOAL.x && y === GOAL.y;
      cell.className = `cell ${grid[y][x] ? 'cell-wall' : goal ? 'cell-goal' : ''}`;
      cell.style.cssText = `left:${ORIGIN_X + x * CELL}px;top:${ORIGIN_Y + y * CELL}px;width:${CELL}px;height:${CELL}px`;
      gridEl.append(cell);
      cells.push(cell);
    }
  }
}

function renderRobot() {
  const inset = (CELL - ROBOT_SIZE) / 2;
  robotEl.style.transitionDuration = `${Math.min(speed(), 220)}ms`;
  robotEl.style.left = `${ORIGIN_X + robot.x * CELL + inset}px`;
  robotEl.style.top = `${ORIGIN_Y + robot.y * CELL + inset}px`;
  robotEl.style.setProperty('--heading', `${robot.dir * 90}deg`);
}

function clearOverlay() {
  for (const cell of cells) cell.classList.remove('open', 'closed', 'path');
}

function setReadout(text, tone = '') {
  readoutEl.textContent = text;
  readoutEl.className = `world-readout ${tone}`;
}

// --- Seed / layout / URL hash ---
function applyLayout() {
  grid = generate(seedEl.value || 'demo', layoutEl.value);
  robot = { x: START.x, y: START.y, dir: 1 };
  renderGrid();
  renderRobot();
  resetStats();
  setReadout(`seed ${seedEl.value} · ${layoutEl.value}`);
  history.replaceState(null, '', `#seed=${encodeURIComponent(seedEl.value)}&layout=${layoutEl.value}`);
}

// --- Run state ---
class StopError extends Error {}
let stopped = false;
let mission_state = 'idle'; // 'en-route' | 'arrived' | 'unreachable'
let replan = false;
const stats = { expanded: 0, path: 0, replans: 0, surprises: 0, moves: 0 };

function checkStop() {
  if (stopped) throw new StopError('stopped by user');
}

function resetStats() {
  Object.assign(stats, { expanded: 0, path: 0, replans: 0, surprises: 0, moves: 0 });
  renderStats();
}

function renderStats() {
  $('stat-expanded').textContent = stats.expanded;
  $('stat-path').textContent = stats.path || '—';
  $('stat-replans').textContent = stats.replans;
  $('stat-surprises').textContent = stats.surprises;
  $('stat-moves').textContent = stats.moves;
}

let current = null; // step the status panel shows
function note(text) {
  if (current) status(current.name, text, current.badge);
}

// --- A* search, one node per call ---
const HEURISTICS = {
  manhattan: (x, y) => Math.abs(GOAL.x - x) + Math.abs(GOAL.y - y),
  euclidean: (x, y) => Math.hypot(GOAL.x - x, GOAL.y - y),
  dijkstra: () => 0,
};

const search = {
  state: 'idle', // 'searching' | 'found' | 'exhausted'
  h: HEURISTICS.manhattan,
  open: [],
  g: new Map(),
  came: new Map(),
  closed: new Set(),
  path: [],
};

function startSearch() {
  search.state = 'searching';
  search.open = [{ x: robot.x, y: robot.y, g: 0, f: search.h(robot.x, robot.y) }];
  search.g = new Map([[key(robot.x, robot.y), 0]]);
  search.came = new Map();
  search.closed = new Set();
  search.path = [];
}

async function expandOne() {
  checkStop();
  if (!search.open.length) {
    search.state = 'exhausted';
    note('frontier empty — no path');
    return;
  }

  // Lowest f, ties broken by lower h (closer to the goal).
  let best = 0;
  for (let i = 1; i < search.open.length; i++) {
    const a = search.open[i];
    const b = search.open[best];
    if (a.f < b.f || (a.f === b.f && a.f - a.g < b.f - b.g)) best = i;
  }
  const node = search.open.splice(best, 1)[0];
  const k = key(node.x, node.y);
  if (search.closed.has(k)) return;

  if (node.x === GOAL.x && node.y === GOAL.y) {
    const path = [];
    for (let at = k; at !== key(robot.x, robot.y); at = search.came.get(at)) {
      const [x, y] = at.split(',').map(Number);
      path.unshift({ x, y });
    }
    search.path = path;
    search.state = 'found';
    stats.path = path.length;
    renderStats();
    note(`goal reached in the search — ${path.length} cells`);
    return;
  }

  search.closed.add(k);
  stats.expanded += 1;
  cellEl(node.x, node.y).classList.replace('open', 'closed') || cellEl(node.x, node.y).classList.add('closed');

  for (const [dx, dy] of VECTORS) {
    const nx = node.x + dx;
    const ny = node.y + dy;
    const nk = key(nx, ny);
    if (isWall(nx, ny) || search.closed.has(nk)) continue;
    const g = node.g + 1;
    if (g < (search.g.get(nk) ?? Infinity)) {
      search.g.set(nk, g);
      search.came.set(nk, k);
      search.open.push({ x: nx, y: ny, g, f: g + search.h(nx, ny) });
      if (!(nx === GOAL.x && ny === GOAL.y)) cellEl(nx, ny).classList.add('open');
    }
  }

  renderStats();
  note(`expanded ${node.x},${node.y} (g ${node.g}) · frontier ${search.open.length}`);
  await sleep(Math.max(4, speed() / 8));
}

// --- Driving ---
function maybeDropWall(index) {
  if (!surpriseEl.checked || stats.surprises >= MAX_SURPRISES || Math.random() > SURPRISE_CHANCE) return;
  const ahead = search.path.slice(index, index + 4).filter((c) => !(c.x === GOAL.x && c.y === GOAL.y));
  if (!ahead.length) return;
  const cell = ahead[Math.floor(Math.random() * ahead.length)];
  grid[cell.y][cell.x] = true;
  stats.surprises += 1;
  const el = cellEl(cell.x, cell.y);
  el.className = 'cell cell-wall surprise';
  renderStats();
}

// for_each callable: `this` is the LoopStep, this.current_item the next cell.
async function driveOne() {
  checkStop();
  if (replan) return 'skipped';
  const next = this.current_item;
  maybeDropWall(this.results.length);

  if (isWall(next.x, next.y)) {
    replan = true;
    stats.replans += 1;
    renderStats();
    note(`blocked at ${next.x},${next.y} — replanning`);
    return 'blocked';
  }

  const dir = VECTORS.findIndex(([dx, dy]) => robot.x + dx === next.x && robot.y + dy === next.y);
  if (dir !== -1) robot.dir = dir;
  robot.x = next.x;
  robot.y = next.y;
  stats.moves += 1;
  cellEl(next.x, next.y).classList.remove('path');
  renderRobot();
  renderStats();
  note(`cell ${this.results.length + 1} of ${search.path.length}`);
  await sleep(speed());
  return 'moved';
}

// --- The workflow ---
const children = new Map(); // step → [{ label, wf }] for the tree view
const body_owner = new Map(); // body workflow id → loop step
const withTimeout = (step) => { step.max_timeout_ms = LONG_TIMEOUT_MS; return step; };

const heuristicCase = (name) => withTimeout(new Case({
  name,
  conditional: { operator: '===', value: name },
  callable: async () => {
    search.h = HEURISTICS[name];
    note(`h = ${name}`);
  },
}));

const drive = new Workflow({
  name: 'drive',
  exit_on_error: true,
  steps: [
    withTimeout(new Step({
      name: 'plot-route',
      callable: async () => {
        for (const c of search.path) if (!(c.x === GOAL.x && c.y === GOAL.y)) cellEl(c.x, c.y).classList.add('path');
        setReadout('driving…');
        note(`${search.path.length} cells`);
        await sleep(Math.min(400, speed() * 2));
      },
    })),
    withTimeout(new LoopStep({
      name: 'follow-path',
      loop_type: 'for_each',
      iterable: () => search.path,
      callable: driveOne,
    })),
    withTimeout(new Step({
      name: 'check-arrival',
      callable: async () => {
        const at_goal = robot.x === GOAL.x && robot.y === GOAL.y;
        mission_state = at_goal ? 'arrived' : 'en-route';
        note(at_goal ? 'at the goal' : 'not there yet — replan');
      },
    })),
  ],
});

const plan_and_drive = new Workflow({
  name: 'plan-and-drive',
  exit_on_error: true,
  steps: [
    withTimeout(new Step({
      name: 'scan',
      callable: async () => {
        checkStop();
        replan = false;
        clearOverlay();
        startSearch();
        setReadout('planning…');
        note(`from ${robot.x},${robot.y} to ${GOAL.x},${GOAL.y}`);
      },
    })),
    withTimeout(new SwitchStep({
      name: 'pick-heuristic',
      subject: () => heuristicEl.value,
      cases: ['manhattan', 'euclidean', 'dijkstra'].map(heuristicCase),
      default_callable: async () => { search.h = HEURISTICS.manhattan; },
    })),
    withTimeout(new LoopStep({
      name: 'a-star-search',
      loop_type: 'while',
      conditional: { subject: () => search.state, operator: '===', value: 'searching' },
      callable: expandOne,
      max_iterations: 10000,
    })),
    withTimeout(new ConditionalStep({
      name: 'path-found?',
      conditional: { subject: () => search.state, operator: '===', value: 'found' },
      true_callable: drive,
      false_callable: async function noPath() {
        mission_state = 'unreachable';
        note('no path — goal unreachable');
      },
    })),
  ],
});

const mission = new Workflow({
  name: 'pathfinder-mission',
  exit_on_error: true,
  steps: [
    withTimeout(new Step({
      name: 'power-on',
      callable: async () => {
        robot = { x: START.x, y: START.y, dir: 1 };
        renderRobot();
        clearOverlay();
        mission_state = 'en-route';
        note(`seed ${seedEl.value} · ${layoutEl.value}`);
        await sleep(200);
      },
    })),
    withTimeout(new LoopStep({
      name: 'until-arrived',
      loop_type: 'while',
      conditional: { subject: () => mission_state, operator: '===', value: 'en-route' },
      callable: plan_and_drive,
      max_iterations: 40,
    })),
    withTimeout(new Step({
      name: 'report',
      callable: async () => {
        note(`${mission_state} · ${stats.moves} moves · ${stats.replans} replans`);
      },
    })),
  ],
});

const loop_until = mission.steps[1];
const path_found = plan_and_drive.steps[3];
const follow_path = drive.steps[1];
const a_star = plan_and_drive.steps[2];
children.set(loop_until, [{ label: 'each leg', wf: plan_and_drive }]);
children.set(path_found, [{ label: 'then', wf: drive }, { label: 'else', fn: 'noPath()' }]);
body_owner.set(plan_and_drive.id, loop_until);

// Nested bodies re-run every leg; keep only the mission's own sessions (see CLAUDE.md).
for (const name of ['workflow_complete', 'workflow_failed']) {
  Workflow.events.workflow.on(name, (wf) => {
    if (wf.id === plan_and_drive.id) plan_and_drive.sessions = {};
    if (wf.id === drive.id) drive.sessions = {};
  });
}

// --- Workflow tree (read-only) ---
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderWorkflow(wf) {
  const node = el('div', 'tree-wf');
  node.dataset.wfId = wf.id;
  node.append(el('div', 'tree-wf-name', `${wf.name}`));
  const list = el('ol', 'tree-list');
  for (const step of wf.steps) {
    const li = el('li', 'tree-step');
    li.dataset.stepId = step.id;
    const head = el('div', 'tree-head');
    head.append(el('span', 'tree-name', step.name), el('span', 'tree-badge', badgeFor(step.prepareForSerialization())));
    const counter = el('span', 'tree-count');
    counter.dataset.countFor = step.id;
    head.append(counter);
    li.append(head);
    for (const child of children.get(step) ?? []) {
      const branch = el('div', 'tree-branch');
      branch.append(el('span', 'tree-branch-label', child.label));
      branch.append(child.wf ? renderWorkflow(child.wf) : el('span', 'tree-fn', child.fn));
      li.append(branch);
    }
    list.append(li);
  }
  node.append(list);
  return node;
}

planEl.replaceChildren(renderWorkflow(mission));

const setCount = (step, text) => {
  const node = planEl.querySelector(`[data-count-for="${step.id}"]`);
  if (node) node.textContent = text;
};

function clearTree() {
  for (const node of planEl.querySelectorAll('.running, .done, .failed, .taken')) {
    node.classList.remove('running', 'done', 'failed', 'taken');
  }
  for (const node of planEl.querySelectorAll('.tree-count')) node.textContent = '';
}

// --- Events → tree + status panel ---
let running = false;
let legs = 0;

for (const name of ['step_running', 'step_complete', 'step_failed']) {
  Workflow.events.step.on(name, (step) => {
    if (!running) return;
    const node = planEl.querySelector(`[data-step-id="${step.id}"]`);
    if (node) {
      node.classList.remove('running', 'done', 'failed');
      node.classList.add({ step_running: 'running', step_complete: 'done', step_failed: 'failed' }[name]);
    }
    if (name === 'step_running') {
      current = { name: step.name, badge: badgeFor(step) };
      status(step.name, 'running', current.badge);
    }
    if (name === 'step_complete' && step.id === a_star.id) setCount(a_star, `${stats.expanded} nodes`);
    if (name === 'step_complete' && step.id === follow_path.id) setCount(follow_path, `${stats.moves} moves`);
  });
}

Workflow.events.workflow.on('workflow_running', (wf) => {
  if (!running) return;
  planEl.querySelector(`[data-wf-id="${wf.id}"]`)?.classList.add('taken');
  if (wf.id === plan_and_drive.id) {
    legs += 1;
    setCount(loop_until, `leg ${legs}`);
  }
});

// --- Runs ---
const runs = [];
let total_replans = 0;

function renderRuns() {
  const sessions = Object.values(mission.sessions ?? {});
  const list = $('runs');
  list.replaceChildren();
  if (!runs.length) {
    list.innerHTML = '<li class="empty">No runs yet.</li>';
    return;
  }
  runs.forEach((run, i) => {
    const session = sessions[i];
    const ms = session?.timing?.execution_time_ms ?? run.ms;
    const li = el('li', `run run-${run.outcome}`);
    li.append(
      el('span', 'run-n', `#${i + 1}`),
      el('span', 'run-status', session?.status ?? 'no session'),
      el('span', 'run-stats', `${(ms / 1000).toFixed(1)} s · ${run.expanded} nodes · path ${run.path} · ${run.replans} replans`),
      el('span', 'run-outcome', `${run.label} · ${run.seed} / ${run.layout} / ${run.heuristic}`),
    );
    list.prepend(li);
  });
  $('run-count').textContent = runs.length;
  $('replan-count').textContent = total_replans;
}

function setRunning(on) {
  running = on;
  goBtn.disabled = on;
  stopBtn.disabled = !on;
  for (const input of [seedEl, layoutEl, $('random-seed')]) input.disabled = on;
}

async function go() {
  // Surprise walls change the grid, so each run starts from the seed's layout.
  grid = generate(seedEl.value || 'demo', layoutEl.value);
  renderGrid();
  resetStats();
  clearTree();
  legs = 0;
  stopped = false;
  setRunning(true);
  setReadout('planning…');
  const started = performance.now();

  try {
    await mission.execute();
  } catch (error) {
    console.error(error);
  }

  setRunning(false);
  const outcome = stopped ? 'stopped' : mission.status === 'failed' ? 'failed' : mission_state;
  const label = { arrived: '★ arrived', unreachable: 'goal unreachable', stopped: 'stopped', failed: 'error' }[outcome] ?? outcome;
  runs.push({
    outcome: { arrived: 'goal', unreachable: 'crashed', stopped: 'stopped', failed: 'crashed' }[outcome] ?? 'finished',
    label,
    ms: performance.now() - started,
    expanded: stats.expanded,
    path: stats.path,
    replans: stats.replans,
    seed: seedEl.value,
    layout: layoutEl.value,
    heuristic: heuristicEl.value,
  });
  total_replans += stats.replans;
  setReadout(label, { arrived: 'good', unreachable: 'bad', stopped: 'warn', failed: 'bad' }[outcome] ?? '');
  const failure = mission.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message;
  status(mission.name, failure && !stopped ? `failed — ${failure}` : `${mission.status} — ${label}`, `Workflow › ${mission.status}`);
  renderRuns();
}

goBtn.addEventListener('click', () => go());
stopBtn.addEventListener('click', () => {
  stopped = true;
  setReadout('stopping…', 'warn');
});
speedEl.addEventListener('input', () => { $('speed-ms').textContent = `${speedEl.value} ms`; });
seedEl.addEventListener('change', applyLayout);
layoutEl.addEventListener('change', applyLayout);
$('random-seed').addEventListener('click', () => {
  seedEl.value = randomSeed();
  applyLayout();
});

// --- Start (and follow share links pasted into an open tab) ---
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  seedEl.value = params.get('seed') || seedEl.value || randomSeed();
  if (GENERATORS[params.get('layout')]) layoutEl.value = params.get('layout');
}

window.addEventListener('hashchange', () => {
  if (running) return;
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('seed') === seedEl.value && params.get('layout') === layoutEl.value) return;
  readHash();
  applyLayout();
});

readHash();
applyLayout();
renderRuns();
