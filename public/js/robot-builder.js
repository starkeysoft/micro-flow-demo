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
import { createEditor, TITLES } from './robot-editor.js';

// --- Levels ---
// '#' wall, '.' floor, 'G' goal, N/E/S/W the robot's start and heading.
const LEVELS = {
  hallway: {
    title: 'Hallway',
    rows: ['##########', '##########', '#E......G#', '##########', '##########', '##########'],
    starter: [
      { kind: 'repeat', times: 7, body: [{ kind: 'move' }, { kind: 'paint' }] },
    ],
  },
  room: {
    title: 'Room lap',
    rows: ['##########', '#E.......#', '#G.......#', '#........#', '#........#', '##########'],
    starter: [
      { kind: 'repeat', times: 4, body: [
        { kind: 'while', cond: { sensor: 'ahead', op: '!==', value: 'wall' }, body: [{ kind: 'move' }, { kind: 'paint' }] },
        { kind: 'right' },
      ] },
    ],
  },
  maze: {
    title: 'Maze',
    rows: ['##########', '#E.#....G#', '#.##.##.##', '#....#...#', '#.##...#.#', '##########'],
    // Right-hand wall follower.
    starter: [
      { kind: 'while', cond: { sensor: 'here', op: '!==', value: 'goal' }, body: [
        { kind: 'switch', sensor: 'right', cases: [
          { value: 'wall', body: [
            { kind: 'if', cond: { sensor: 'ahead', op: 'in', value: 'wall' }, then: [{ kind: 'left' }], else: [{ kind: 'move' }] },
          ] },
        ], default: [{ kind: 'right' }, { kind: 'move' }] },
      ] },
    ],
  },
};

const CELL = 60;
const ORIGIN = 20; // grid offset inside the 640×400 arena
const ROBOT_SIZE = 44;
const DIRS = ['north', 'east', 'south', 'west'];
const VECTORS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const LONG_TIMEOUT_MS = 10 * 60 * 1000; // programs can run for a while
const PROGRAM_KEY = 'robot-builder:program';

const $ = (id) => document.getElementById(id);
const gridEl = $('grid');
const robotEl = $('robot');
const readoutEl = $('readout');
const runBtn = $('run');
const stopBtn = $('stop');
const speedEl = $('speed');
const levelEl = $('level');
const jsonPanel = $('json-panel');

const status = createStatusPanel();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const speed = () => Number(speedEl.value);

// --- World + robot ---
let level_key = 'maze';
let robot = null;
let painted = new Set();

function startOf(rows) {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const dir = 'NESW'.indexOf(rows[y][x]);
      if (dir !== -1) return { x, y, dir };
    }
  }
  return { x: 1, y: 1, dir: 1 };
}

function cellAt(x, y) {
  const ch = LEVELS[level_key].rows[y]?.[x] ?? '#';
  if (ch === '#') return 'wall';
  if (ch === 'G') return 'goal';
  return painted.has(`${x},${y}`) ? 'painted' : 'empty';
}

function look(turn) {
  const [dx, dy] = VECTORS[(robot.dir + turn + 4) % 4];
  return cellAt(robot.x + dx, robot.y + dy);
}

function renderGrid() {
  const rows = LEVELS[level_key].rows;
  gridEl.replaceChildren();
  rows.forEach((row, y) => [...row].forEach((_, x) => {
    const cell = document.createElement('div');
    cell.className = `cell cell-${cellAt(x, y)}`;
    cell.dataset.cell = `${x},${y}`;
    cell.style.left = `${ORIGIN + x * CELL}px`;
    cell.style.top = `${ORIGIN + y * CELL}px`;
    gridEl.append(cell);
  }));
}

function renderRobot() {
  const inset = (CELL - ROBOT_SIZE) / 2;
  robotEl.style.transitionDuration = `${Math.min(speed(), 280)}ms`;
  robotEl.style.left = `${ORIGIN + robot.x * CELL + inset}px`;
  robotEl.style.top = `${ORIGIN + robot.y * CELL + inset}px`;
  robotEl.style.setProperty('--heading', `${robot.dir * 90}deg`);
}

function resetWorld() {
  painted = new Set();
  robot = { ...startOf(LEVELS[level_key].rows), moves: 0, paints: 0, goal: false };
  renderGrid();
  renderRobot();
}

function setReadout(text, tone = '') {
  readoutEl.textContent = text;
  readoutEl.className = `world-readout ${tone}`;
}

// --- Actions and sensors (the only demo code a program runs) ---
class StopError extends Error {}
let stopped = false;
let last_error = null;

function checkStop() {
  if (stopped) throw new StopError('stopped by user');
}

const ACTIONS = {
  async move() {
    checkStop();
    if (look(0) === 'wall') {
      robotEl.classList.add('flash');
      setTimeout(() => robotEl.classList.remove('flash'), 400);
      last_error = `bonk: wall ahead at ${robot.x},${robot.y} facing ${DIRS[robot.dir]}`;
      throw new Error(last_error);
    }
    const [dx, dy] = VECTORS[robot.dir];
    robot.x += dx;
    robot.y += dy;
    robot.moves += 1;
    renderRobot();
    if (cellAt(robot.x, robot.y) === 'goal' && !robot.goal) {
      robot.goal = true;
      const goal = gridEl.querySelector(`[data-cell="${robot.x},${robot.y}"]`);
      goal.classList.add('reached');
    }
    await sleep(speed());
  },
  async left() {
    checkStop();
    robot.dir = (robot.dir + 3) % 4;
    renderRobot();
    await sleep(speed());
  },
  async right() {
    checkStop();
    robot.dir = (robot.dir + 1) % 4;
    renderRobot();
    await sleep(speed());
  },
  async paint() {
    checkStop();
    const key = `${robot.x},${robot.y}`;
    if (!painted.has(key) && cellAt(robot.x, robot.y) !== 'goal') {
      painted.add(key);
      robot.paints += 1;
      gridEl.querySelector(`[data-cell="${key}"]`).className = 'cell cell-painted';
    }
    await sleep(speed());
  },
};

const SENSORS = {
  ahead: () => look(0),
  left: () => look(-1),
  right: () => look(1),
  here: () => cellAt(robot.x, robot.y),
  facing: () => DIRS[robot.dir],
  moves: () => robot.moves,
};

// A condition subject is a function, called by micro-flow each time the
// condition is checked.
const sensorFn = (name) => () => {
  checkStop();
  return SENSORS[name]();
};

function parseValue(op, value) {
  if (op === 'in' || op === 'not_in') return String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (op === '<' || op === '>=') return Number(value);
  return String(value);
}

const makeConditional = (cond) => ({
  subject: sensorFn(cond.sensor),
  operator: cond.op,
  value: parseValue(cond.op, cond.value),
});

// --- Blocks → micro-flow ---
// meta links each step to its block settings; workflows and steps_by_id let
// event payloads (which carry ids) find the live objects.
const meta = new WeakMap();
const workflows = new Map();
const steps_by_id = new Map();
const body_owner = new Map(); // body workflow id → the step that runs it

function long(step) {
  step.max_timeout_ms = LONG_TIMEOUT_MS;
  steps_by_id.set(step.id, step);
  return step;
}

function makeBody(name, blocks) {
  const wf = new Workflow({ name, exit_on_error: true, steps: blocks.map(buildStep) });
  workflows.set(wf.id, wf);
  return wf;
}

function makeCase(value, blocks) {
  const body = makeBody(`case-${value || 'blank'}-body`, blocks);
  const step = long(new Case({
    name: `case ${value}`,
    conditional: { operator: '===', value },
    callable: body,
  }));
  return { value, step, body };
}

function buildStep(block) {
  switch (block.kind) {
    case 'repeat': {
      const body = makeBody('repeat-body', block.body ?? []);
      const step = long(new LoopStep({ name: 'repeat', loop_type: 'for', iterations: block.times, callable: body }));
      meta.set(step, { kind: 'repeat', times: block.times, body });
      body_owner.set(body.id, step);
      return step;
    }
    case 'while': {
      const body = makeBody('while-body', block.body ?? []);
      const step = long(new LoopStep({ name: 'repeat while', loop_type: 'while', callable: body, max_iterations: 500 }));
      step.setConditional(makeConditional(block.cond));
      meta.set(step, { kind: 'while', cond: { ...block.cond }, body });
      body_owner.set(body.id, step);
      return step;
    }
    case 'if': {
      const then_wf = makeBody('then-body', block.then ?? []);
      const else_wf = makeBody('else-body', block.else ?? []);
      const step = long(new ConditionalStep({
        name: 'if',
        conditional: makeConditional(block.cond),
        true_callable: then_wf,
        false_callable: else_wf,
      }));
      meta.set(step, { kind: 'if', cond: { ...block.cond }, then: then_wf, else: else_wf });
      body_owner.set(then_wf.id, step);
      body_owner.set(else_wf.id, step);
      return step;
    }
    case 'switch': {
      const cases = (block.cases ?? []).map((c) => makeCase(c.value, c.body ?? []));
      const default_wf = makeBody('default-body', block.default ?? []);
      const step = long(new SwitchStep({
        name: 'switch',
        subject: sensorFn(block.sensor),
        cases: cases.map((c) => c.step),
        default_callable: default_wf,
      }));
      meta.set(step, { kind: 'switch', sensor: block.sensor, cases, default: default_wf });
      for (const c of cases) body_owner.set(c.body.id, step);
      body_owner.set(default_wf.id, step);
      return step;
    }
    default: {
      const step = long(new Step({ name: TITLES[block.kind], callable: ACTIONS[block.kind] }));
      meta.set(step, { kind: block.kind });
      return step;
    }
  }
}

// Workflow tree → the demo's own block JSON (for autosave and share links).
function blockOf(step) {
  const m = meta.get(step);
  const list = (wf) => wf.steps.map(blockOf);
  switch (m.kind) {
    case 'repeat': return { kind: 'repeat', times: m.times, body: list(m.body) };
    case 'while':  return { kind: 'while', cond: { ...m.cond }, body: list(m.body) };
    case 'if':     return { kind: 'if', cond: { ...m.cond }, then: list(m.then), else: list(m.else) };
    case 'switch': return {
      kind: 'switch',
      sensor: m.sensor,
      cases: m.cases.map((c) => ({ value: c.value, body: list(c.body) })),
      default: list(m.default),
    };
    default: return { kind: m.kind };
  }
}

// The one program Workflow. It's edited in place and executed again on every Run.
const program = new Workflow({ name: 'robot-program', exit_on_error: true, steps: [] });
workflows.set(program.id, program);

function loadProgram(blocks) {
  program.clearSteps();
  program.addSteps(blocks.map(buildStep));
}

// Setting changes the editor makes to live steps.
const ops = {
  buildStep,
  blockOf,
  setTimes(step, times) {
    meta.get(step).times = times;
    step.iterations = times;
  },
  setCondition(step, cond) {
    meta.get(step).cond = cond;
    step.setConditional(makeConditional(cond));
  },
  setSwitchSensor(step, sensor) {
    meta.get(step).sensor = sensor;
    step.subject = sensorFn(sensor);
  },
  addCase(step) {
    const c = makeCase('empty', [{ kind: 'move' }]);
    step.cases.push(c.step);
    meta.get(step).cases.push(c);
    body_owner.set(c.body.id, step);
  },
  removeCase(step, index) {
    step.cases.splice(index, 1);
    meta.get(step).cases.splice(index, 1);
  },
  setCaseValue(step, index, value) {
    const c = meta.get(step).cases[index];
    c.value = value;
    c.step.name = `case ${value}`;
    c.step.setConditional({ subject: null, operator: '===', value });
  },
};

const editor = createEditor({ root: $('editor'), program, meta, ops, onChange: programChanged });

// --- Save / share ---
function encode(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return btoa(String.fromCharCode(...bytes));
}

function decode(text) {
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function snapshot() {
  return { v: 1, level: level_key, program: program.steps.map(blockOf) };
}

function saveLocal() {
  try { localStorage.setItem(PROGRAM_KEY, JSON.stringify(snapshot())); } catch { /* ignore */ }
}

function readSaved() {
  const hash = new URLSearchParams(location.hash.slice(1)).get('p');
  if (hash) {
    try { return decode(hash); } catch (error) { console.error('Bad share link', error); }
  }
  try { return JSON.parse(localStorage.getItem(PROGRAM_KEY)); } catch { return null; }
}

function renderJSON() {
  if (jsonPanel.open) $('json').textContent = JSON.stringify(program.prepareForSerialization(), null, 2);
}

function programChanged({ rerender = true } = {}) {
  if (rerender) editor.render();
  saveLocal();
  renderJSON();
}

// --- Event-driven run UI ---
let running = false;
const iteration_counts = new Map();

function describe(step) {
  const m = steps_by_id.has(step.id) ? meta.get(steps_by_id.get(step.id)) : null;
  if (!m) return step.class_name === 'case' ? 'case matched' : 'running';
  const cond = m.cond ? `${m.cond.sensor} ${m.cond.op} ${m.cond.value}` : '';
  switch (m.kind) {
    case 'repeat': return `${m.times} iterations`;
    case 'while':  return `while ${cond}`;
    case 'if':     return `if ${cond}`;
    case 'switch': return `on ${m.sensor} = ${SENSORS[m.sensor]()}`;
    default:       return TITLES[m.kind];
  }
}

for (const name of ['step_running', 'step_complete', 'step_failed']) {
  Workflow.events.step.on(name, (step) => {
    if (!running) return;
    const state = { step_running: 'running', step_complete: 'done', step_failed: 'failed' }[name];
    editor.mark(step.id, state);
    if (name === 'step_running') {
      iteration_counts.delete(step.id); // a loop starting again counts from zero
      status(step.name, describe(step), badgeFor(step));
    }
  });
}

Workflow.events.step.on('conditional_true_branch_executed', (step) => {
  if (running) status(step.name, 'condition true → then', badgeFor(step));
});
Workflow.events.step.on('conditional_false_branch_executed', (step) => {
  if (running) status(step.name, 'condition false → else', badgeFor(step));
});

Workflow.events.workflow.on('workflow_running', (wf) => {
  if (!running) return;
  editor.markBody(wf.id);
  const owner = body_owner.get(wf.id);
  const m = owner && meta.get(owner);
  if (m && (m.kind === 'repeat' || m.kind === 'while')) {
    const k = (iteration_counts.get(owner.id) ?? 0) + 1;
    iteration_counts.set(owner.id, k);
    editor.setIteration(owner.id, m.kind === 'repeat' ? `${k}/${m.times}` : `×${k}`);
  }
});

// Body workflows run many times per program run, and each run adds an entry to
// their `sessions`. Every snapshot of a body (in loop results, step results and
// event payloads) embeds all of them, so nested payloads grow much faster than
// the iteration count; a long maze run overflows JSON.stringify inside emit().
// Only the program's own sessions (the Runs panel) are needed, so bodies drop
// theirs after each run. This listener runs before execute() takes its final snapshot.
for (const name of ['workflow_complete', 'workflow_failed']) {
  Workflow.events.workflow.on(name, (wf) => {
    if (wf.id !== program.id) {
      const body = workflows.get(wf.id);
      if (body) body.sessions = {};
    }
  });
}

// --- Running ---
const runs = [];
let total_moves = 0;

function setRunning(on) {
  running = on;
  runBtn.disabled = on;
  stopBtn.disabled = !on;
  levelEl.disabled = on;
  $('starter').disabled = on;
  $('editor').disabled = on;
}

function renderRuns() {
  const sessions = Object.values(program.sessions ?? {});
  const list = $('runs');
  list.replaceChildren();
  if (!runs.length) {
    list.innerHTML = '<li class="empty">No runs yet.</li>';
    return;
  }
  runs.forEach((run, i) => {
    const session = sessions[i];
    const ms = session?.timing?.execution_time_ms ??
      (session ? new Date(session.timing.complete_time) - new Date(session.timing.start_time) : run.ms);
    const li = document.createElement('li');
    li.className = `run run-${run.outcome}`;
    li.innerHTML = `<span class="run-n">#${i + 1}</span>
      <span class="run-status">${session?.status ?? 'no session'}</span>
      <span class="run-stats">${(ms / 1000).toFixed(1)} s · ${run.moves} moves · ${run.paints} paints</span>
      <span class="run-outcome">${run.label}</span>`;
    list.prepend(li);
  });
  $('run-count').textContent = runs.length;
  $('move-count').textContent = total_moves;
}

async function run() {
  resetWorld();
  editor.clearMarks();
  iteration_counts.clear();
  stopped = false;
  last_error = null;
  setRunning(true);
  setReadout('running…');
  const started = performance.now();

  try {
    await program.execute();
  } catch (error) {
    console.error(error);
  }

  setRunning(false);
  const outcome = stopped ? 'stopped' : program.status === 'failed' ? 'crashed' : robot.goal ? 'goal' : 'finished';
  // A bonk sets last_error; any other failure (e.g. a library error) is read from the failed step.
  const failure = last_error ??
    program.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message ?? 'workflow failed';
  const label = {
    stopped: 'stopped',
    crashed: last_error ? 'bonk!' : `error: ${failure}`,
    goal: '★ goal',
    finished: 'finished, no goal',
  }[outcome];
  runs.push({ outcome, label, moves: robot.moves, paints: robot.paints, ms: performance.now() - started });
  total_moves += robot.moves;

  const tone = { goal: 'good', crashed: 'bad', stopped: 'warn', finished: 'warn' }[outcome];
  setReadout(outcome === 'crashed' ? failure : label, tone);
  status(program.name, outcome === 'crashed' ? `failed — ${failure}` : `${program.status} — ${label}`, `Workflow › ${program.status}`);
  renderRuns();
}

runBtn.addEventListener('click', () => run());
stopBtn.addEventListener('click', () => {
  stopped = true;
  setReadout('stopping…', 'warn');
});
speedEl.addEventListener('input', () => {
  $('speed-ms').textContent = `${speedEl.value} ms`;
});

levelEl.replaceChildren(...Object.entries(LEVELS).map(([key, lvl]) => new Option(lvl.title, key)));
levelEl.addEventListener('change', () => {
  level_key = levelEl.value;
  resetWorld();
  saveLocal();
});

$('starter').addEventListener('click', () => {
  loadProgram(LEVELS[level_key].starter);
  programChanged();
});

$('share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#p=${encode(snapshot())}`;
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    $('share').textContent = 'Copied';
  } catch {
    $('share').textContent = 'See URL';
  }
  setTimeout(() => { $('share').textContent = 'Share'; }, 1600);
});

jsonPanel.addEventListener('toggle', renderJSON);

// --- Start ---
const saved = readSaved();
level_key = LEVELS[saved?.level] ? saved.level : 'maze';
levelEl.value = level_key;
try {
  loadProgram(saved?.program ?? LEVELS[level_key].starter);
} catch (error) {
  console.error('Could not load saved program', error);
  loadProgram(LEVELS[level_key].starter);
}
resetWorld();
programChanged();
renderRuns();
