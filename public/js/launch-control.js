import {
  Workflow,
  Step,
  LoopStep,
  DelayStep,
  SwitchStep,
  Case,
  FlowControlStep,
  CallableRegistry,
} from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { createFeed, TOP_WORKFLOW, SUB_WORKFLOW, SNAPSHOT_REQUEST, SNAPSHOT_EVENT } from './launch-feed.js';

const SYSTEMS = ['guidance', 'propulsion', 'telemetry', 'comms', 'life-support'];
const WINDOW_MS = 10000;          // launch window opens this long after pre-flight
const RANGE_SAFETY_LIMIT_MS = 1500;
const CHECKPOINT_KEY = 'launch-control:checkpoint';
const COUNTERS_KEY = 'launch-control:counters';

const $ = (id) => document.getElementById(id);
const readoutEl = $('readout');
const readoutSubEl = $('readout-sub');
const fuelFillEl = $('fuel-fill');
const fuelPctEl = $('fuel-pct');
const systemsEl = $('systems');
const weatherEl = $('weather');
const rocketEl = $('rocket');
const boosterEl = $('booster');
const flameEl = $('flame');
const starsEl = $('stars');
const launchBtn = $('launch');
const pauseBtn = $('pause');
const resetBtn = $('reset');
const chaosEl = $('chaos');
const chaosPctEl = $('chaos-pct');
const weatherSelectEl = $('weather-select');
const fastTrackEl = $('fast-track');
const bannerEl = $('banner');

const status = createStatusPanel();
const feed = createFeed({ timelineEl: $('timeline'), logEl: $('log'), status });

// Drive the timeline, event log and status panel from micro-flow's own event
// bus. Every emit is also broadcast to other tabs (see launch-observer.js).
for (const name of Object.values(Workflow.event_names.step)) {
  Workflow.events.step.on(name, (detail) => feed.handleStepEvent(name, detail));
}
for (const name of Object.values(Workflow.event_names.workflow)) {
  Workflow.events.workflow.on(name, (detail) => feed.handleWorkflowEvent(name, detail));
}

// An observer tab that opens mid-launch missed workflow_running, so it asks
// for the current workflow. The reply is emitted (and broadcast) serialized,
// with every step's status. sessions/results are left out to keep the
// broadcast small; the observer only needs the steps.
Workflow.events.workflow.onBroadcast(SNAPSHOT_REQUEST, () => {
  if (!mission) return;
  const { sessions, results, ...snapshot } = mission.prepareForSerialization();
  Workflow.events.workflow.emit(SNAPSHOT_EVENT, snapshot);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const chaos = () => Number(chaosEl.value) / 100;
const time = (date) => new Date(date).toLocaleTimeString([], { hour12: false });

// --- localStorage (may be unavailable; the demo still works without it) ---
function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// --- Scene ---
function setReadout(main, sub = '', tone = '') {
  readoutEl.textContent = main;
  readoutEl.className = `readout-main ${tone}`;
  readoutSubEl.textContent = sub;
}

function setFuel(pct) {
  fuelFillEl.style.height = `${pct}%`;
  fuelPctEl.textContent = `${pct}%`;
}

function setSystem(system, state) {
  systemsEl.querySelector(`[data-system="${system}"]`).className = `system ${state}`;
}

function setWeather(weather) {
  weatherEl.textContent = weather ?? '—';
  weatherEl.className = weather ?? '';
}

function setAltitude(px, scale = 1) {
  rocketEl.style.transform = `translateY(${-px}px) scale(${scale})`;
}

function resetScene() {
  systemsEl.replaceChildren(...SYSTEMS.map((system) => {
    const li = document.createElement('li');
    li.className = 'system';
    li.dataset.system = system;
    const light = document.createElement('span');
    light.className = 'light';
    li.append(light, system);
    return li;
  }));
  setFuel(0);
  setWeather(null);
  setAltitude(0);
  rocketEl.classList.remove('shake', 'orbit');
  boosterEl.classList.remove('detached');
  flameEl.classList.remove('on');
  starsEl.classList.remove('on');
  setReadout('READY', 'press launch');
}

// Restore what the scene showed, from a hydrated workflow's instance state.
function renderSceneFromState(state) {
  resetScene();
  setFuel(state.fuel ?? 0);
  setWeather(state.weather);
  for (const [system, result] of Object.entries(state.systems ?? {})) setSystem(system, result);
  setReadout('HOLD', 'restored from checkpoint', 'warn');
}

// --- Callables ---
// Every function callable is registered by name, and every step that uses one
// passes the same name as its *_registry_key. That is what lets
// Workflow.hydrate() turn a serialized checkpoint back into live steps.
const registry = new CallableRegistry();

registry.registerMany({
  // `this` is the step; this.getState/setState read and write the workflow's own state.
  async preFlight() {
    const weather = weatherSelectEl.value === 'auto' ? drawWeather() : weatherSelectEl.value;
    const window_at = new Date(Date.now() + WINDOW_MS);

    this.setState('fuel', 0);
    this.setState('systems', {});
    this.setState('scrubbed', false);
    this.setState('weather', weather);
    this.setState('launch_window', window_at.toISOString());

    // getState('workflow') is the live parent Workflow, so a step can
    // reconfigure a later step before it runs.
    const workflow = this.getState('workflow');
    workflow.steps.find((s) => s.name === 'launch-window').absolute_timestamp = window_at;

    resetScene();
    setWeather(weather);
    setReadout('PRE-FLIGHT', `window opens ${time(window_at)}`);
    feed.note(`weather: ${weather}, window ${time(window_at)}`);
    await sleep(700);
  },

  // while loop: runs until the fuel-load conditional (fuel < 100) is false.
  async loadFuel() {
    const fuel = Math.min(100, this.getState('fuel') + 6 + Math.floor(Math.random() * 9));
    this.setState('fuel', fuel);
    setFuel(fuel);
    feed.note(`iteration ${this.results.length + 1} — fuel ${fuel}%`);
    await sleep(200);
  },

  // for_each loop over SYSTEMS: each system gets a new standalone Step with
  // retries, so its retries show up as extra step_running events.
  async checkSystem() {
    const system = this.current_item;
    setSystem(system, 'checking');
    setReadout('SYSTEMS', `checking ${system}`);

    const check = new Step({
      name: `check-${system}`,
      max_retries: 3,
      callable: async () => {
        await sleep(280);
        if (Math.random() < chaos()) throw new Error(`${system} did not respond`);
      },
    });
    await check.execute();

    const ok = check.status === 'complete';
    this.setState(`systems.${system}`, ok ? 'go' : 'fail');
    setSystem(system, ok ? 'go' : 'fail');

    if (!ok) throw new Error(`${system} failed after ${check.retry_count} retries`);
    return { system, retries: check.retry_count };
  },

  // Runs under max_timeout_ms; high chaos makes the handshake slow enough to time out.
  async rangeSafety() {
    const ms = 250 + Math.random() * 500 + Math.random() * chaos() * 4000;
    setReadout('RANGE', 'safety handshake');
    feed.note(`handshake… (limit ${RANGE_SAFETY_LIMIT_MS} ms)`);
    await sleep(ms);
    return { handshake_ms: Math.round(ms) };
  },

  async weatherClear() {
    setReadout('GO', 'weather clear', 'good');
    feed.note('clear — GO');
    await sleep(500);
  },

  async weatherStorm() {
    this.setState('scrubbed', true);
    feed.note('storm — scrubbing');
  },

  async weatherUnknown() {
    this.setState('scrubbed', true);
    feed.note(`unknown weather "${this.getState('weather')}" — scrubbing`);
  },

  // Generator loop: each yielded value is pushed onto the LoopStep's results.
  async *countdown() {
    for (let t = 10; t >= 0; t--) {
      setReadout(`T-${String(t).padStart(2, '0')}`, 'terminal count', t <= 3 ? 'warn' : '');
      feed.note(`yield "T-${t}"`);
      if (t === 3) flameEl.classList.add('on');
      yield `T-${t}`;
      if (t) await sleep(420);
    }
  },

  // --- steps of the nested "ascent" workflow ---
  async ignition() {
    setReadout('LIFTOFF', 'ignition', 'good');
    flameEl.classList.add('on');
    rocketEl.classList.add('shake');
    await sleep(700);
  },

  async climb() {
    const i = this.results.length + 1;
    setAltitude(i * 16);
    feed.note(`iteration ${i} of 10 — altitude ${i * 16}`);
    await sleep(240);
  },

  async maxQ() {
    setReadout('MAX-Q', 'max aerodynamic pressure', 'warn');
    await sleep(700);
  },

  async stageSeparation() {
    setReadout('STAGING', 'booster separation');
    rocketEl.classList.remove('shake');
    boosterEl.classList.add('detached');
    await sleep(900);
  },

  async orbit() {
    rocketEl.classList.add('orbit');
    setAltitude(230, 0.6);
    starsEl.classList.add('on');
    await sleep(1400);
    flameEl.classList.remove('on');
    setReadout('ORBIT', 'insertion confirmed', 'good');
  },

  async missionComplete() {
    counters.launches += 1;
    feed.note('orbit achieved');
    await sleep(300);
  },

  // Condition subjects, the switch subject and the per-step checkpoint saver.
  // They read the active `mission`, so they can be plain named functions: 3.1.0
  // serializes function-valued subjects by name and hydrate() resolves them
  // from this registry, so nothing has to be re-attached after a reload.
  fuelLevel: () => mission.getState('fuel'),
  weatherReport: () => mission.getState('weather'),
  isScrubbed: () => mission.getState('scrubbed'),
  fastTrackOn: () => fastTrackEl.checked,
  saveCheckpoint: (serialized) => saveCheckpoint(mission, serialized),
});

// Build a step option pair for a registered function callable.
const fn = (key) => ({ callable: registry.get(key), callable_registry_key: key });

function drawWeather() {
  const r = Math.random();
  return r < 0.55 ? 'clear' : r < 0.85 ? 'windy' : 'storm';
}

// --- Workflow factory ---
function buildAscentWorkflow() {
  return new Workflow({
    name: SUB_WORKFLOW,
    callable_registry: registry,
    exit_on_error: true,
    steps: [
      new Step({ name: 'ignition', ...fn('ignition') }),
      new LoopStep({
        name: 'climb',
        loop_type: 'for',
        iterations: 10,
        callable: registry.get('climb'),
        loop_callable_registry_key: 'climb',
      }),
      new Step({ name: 'max-q', ...fn('maxQ') }),
      new Step({ name: 'stage-separation', ...fn('stageSeparation') }),
      new Step({ name: 'orbit', ...fn('orbit') }),
    ],
  });
}

function buildLaunchWorkflow() {
  return new Workflow({
    name: TOP_WORKFLOW,
    callable_registry: registry,
    exit_on_error: true, // a failed step aborts the launch instead of carrying on
    // Checkpoint after every step.
    result_per_step: true,
    result_per_step_function: registry.get('saveCheckpoint'),
    result_per_step_function_registry_key: 'saveCheckpoint',
    steps: [
      // 1. STEP — reset state, pick the weather, set the launch window
      new Step({ name: 'pre-flight', ...fn('preFlight') }),

      // 2. LOOP STEP (while) — runs while fuel < 100
      new LoopStep({
        name: 'fuel-load',
        loop_type: 'while',
        conditional: { subject: registry.get('fuelLevel'), operator: '<', value: 100 },
        callable: registry.get('loadFuel'),
        loop_callable_registry_key: 'loadFuel',
      }),

      // 3. LOOP STEP (for_each) — a plain array iterable survives serialization
      new LoopStep({
        name: 'systems-check',
        loop_type: 'for_each',
        iterable: SYSTEMS,
        callable: registry.get('checkSystem'),
        loop_callable_registry_key: 'checkSystem',
      }),

      // 4. STEP with a timeout
      new Step({ name: 'range-safety', max_timeout_ms: RANGE_SAFETY_LIMIT_MS, ...fn('rangeSafety') }),

      // 5. SWITCH STEP — on the weather picked in pre-flight
      new SwitchStep({
        name: 'weather-go-no-go',
        subject: registry.get('weatherReport'),
        cases: [
          new Case({ name: 'case-clear', conditional: { operator: '===', value: 'clear' }, ...fn('weatherClear') }),
          // A Case's callable can be another Step: here, a DelayStep.
          new Case({
            name: 'case-windy',
            conditional: { operator: '===', value: 'windy' },
            callable: new DelayStep({ name: 'wind-hold', delay_type: 'relative', relative_delay_ms: 2500 }),
          }),
          new Case({ name: 'case-storm', conditional: { operator: '===', value: 'storm' }, ...fn('weatherStorm') }),
        ],
        default_callable: registry.get('weatherUnknown'),
        default_callable_registry_key: 'weatherUnknown',
      }),

      // 6. FLOW CONTROL (break) — stops the workflow when scrubbed
      new FlowControlStep({
        name: 'scrub-gate',
        flow_control_type: 'break',
        conditional: { subject: registry.get('isScrubbed'), operator: '===', value: true },
      }),

      // 7. FLOW CONTROL (skip) — skips the next step when fast-track is on
      new FlowControlStep({
        name: 'fast-track-gate',
        flow_control_type: 'skip',
        conditional: { subject: registry.get('fastTrackOn'), operator: '===', value: true },
      }),

      // 8. DELAY STEP (relative) — the step fast-track skips
      new DelayStep({ name: 'built-in-hold', delay_type: 'relative', relative_delay_ms: 3000 }),

      // 9. DELAY STEP (absolute) — timestamp set by pre-flight
      new DelayStep({ name: 'launch-window', delay_type: 'absolute' }),

      // 10. LOOP STEP (generator)
      new LoopStep({
        name: 'countdown',
        loop_type: 'generator',
        callable: registry.get('countdown'),
        loop_callable_registry_key: 'countdown',
      }),

      // 11. STEP whose callable is a nested Workflow
      new Step({ name: 'ascent', callable: buildAscentWorkflow() }),

      // 12. STEP — bump the launch counter
      new Step({ name: 'mission-complete', ...fn('missionComplete') }),
    ],
  });
}

// --- Checkpoints ---
// serialize() covers the steps (and, by registry name, their function-valued
// conditions). Instance state is runtime-only by design, so it's saved next to it.
function saveCheckpoint(wf, serialized = wf.prepareForSerialization()) {
  const { workflow, ...state } = wf.state.data;
  storageSet(CHECKPOINT_KEY, { workflow: serialized, state, saved_at: new Date().toISOString() });
}

function restoreFromCheckpoint(checkpoint) {
  const wf = Workflow.hydrate(checkpoint.workflow, registry);
  for (const [key, value] of Object.entries(checkpoint.state)) wf.setState(key, value);

  // Saved mid-run (the tab closed during a step): treat it as paused so
  // execute()/resume() continues after the last completed step.
  wf.status = 'paused';
  return wf;
}

// --- Counters ---
const counters = { launches: 0, scrubs: 0, aborts: 0, ...storageGet(COUNTERS_KEY) };
function renderCounters() {
  $('launches').textContent = counters.launches;
  $('scrubs').textContent = counters.scrubs;
  $('aborts').textContent = counters.aborts;
  storageSet(COUNTERS_KEY, counters);
}

// --- Running a mission ---
let mission = null;

function setMode(mode) {
  launchBtn.disabled = mode !== 'idle';
  resetBtn.disabled = mode === 'running';
  pauseBtn.disabled = mode === 'idle';
  pauseBtn.textContent = mode === 'paused' ? 'Resume' : 'Pause';
  pauseBtn.dataset.mode = mode;
}

async function drive(run) {
  bannerEl.hidden = true;
  setMode('running');
  try {
    await run();
  } catch (error) {
    console.error(error);
  }

  if (mission.status === 'paused') {
    saveCheckpoint(mission);
    const at = mission.steps.find((s) => s.id === mission.current_step)?.name;
    setReadout('HOLD', `paused after ${at}`, 'warn');
    setMode('paused');
    return;
  }

  storageRemove(CHECKPOINT_KEY);

  if (mission.status === 'failed') {
    const failed = mission.steps.find((s) => s.status === 'failed');
    const reason = failed?.errors.at(-1)?.message ?? 'unknown error';
    counters.aborts += 1;
    flameEl.classList.remove('on');
    rocketEl.classList.remove('shake');
    setReadout('ABORT', failed?.name ?? '', 'bad');
    status(TOP_WORKFLOW, `aborted — ${reason}`, 'Workflow › failed');
  } else if (mission.getState('scrubbed')) {
    counters.scrubs += 1;
    setReadout('SCRUB', `weather: ${mission.getState('weather')}`, 'bad');
    status(TOP_WORKFLOW, 'scrubbed — scrub-gate broke the workflow', 'FlowControlStep › break');
  } else {
    status(TOP_WORKFLOW, 'complete — orbit achieved', 'Workflow › complete');
  }

  renderCounters();
  setMode('idle');
}

launchBtn.addEventListener('click', () => {
  storageRemove(CHECKPOINT_KEY);
  feed.reset();
  mission = buildLaunchWorkflow();
  drive(() => mission.execute());
});

pauseBtn.addEventListener('click', () => {
  if (pauseBtn.dataset.mode === 'paused') {
    drive(() => mission.resume());
  } else {
    // Takes effect once the current step finishes.
    mission.pause();
    pauseBtn.disabled = true;
    pauseBtn.textContent = 'Pausing…';
  }
});

resetBtn.addEventListener('click', () => {
  storageRemove(CHECKPOINT_KEY);
  mission = null;
  bannerEl.hidden = true;
  feed.reset();
  resetScene();
  status('—', '—', '—');
  setMode('idle');
});

chaosEl.addEventListener('input', () => {
  chaosPctEl.textContent = `${chaosEl.value}%`;
});

// --- Resume a checkpoint from an earlier visit ---
function offerCheckpoint() {
  const checkpoint = storageGet(CHECKPOINT_KEY);
  if (!checkpoint?.workflow) return;

  const last = checkpoint.workflow.steps.find((s) => s.id === checkpoint.workflow.current_step);
  $('banner-text').textContent =
    `Saved launch from ${time(checkpoint.saved_at)}: last checkpoint after "${last?.name ?? 'start'}".`;
  bannerEl.hidden = false;

  $('banner-resume').onclick = () => {
    try {
      feed.reset();
      mission = restoreFromCheckpoint(checkpoint);
      renderSceneFromState(checkpoint.state);
      drive(() => mission.resume());
    } catch (error) {
      console.error(error);
      $('banner-text').textContent = `Couldn't restore the checkpoint: ${error.message}`;
      storageRemove(CHECKPOINT_KEY);
    }
  };
  $('banner-discard').onclick = () => {
    storageRemove(CHECKPOINT_KEY);
    bannerEl.hidden = true;
  };
}

resetScene();
renderCounters();
setMode('idle');
offerCheckpoint();
