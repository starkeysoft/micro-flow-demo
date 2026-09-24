import {
  Workflow,
  Step,
  DelayStep,
  LoopStep,
  ConditionalStep,
} from 'micro-flow';
import { createStatusPanel } from './status-panel.js';

const box    = document.getElementById('box');
const arena  = document.getElementById('arena');
const lapsEl = document.getElementById('laps');

const status = createStatusPanel({
  'initialize':                 'Step',
  'move-right':                 'LoopStep › for',
  'announce-pause-top-right':   'Step',
  'pause-top-right':            'DelayStep',
  'move-down':                  'LoopStep › for',
  'check-laps':                 'ConditionalStep',
  'move-left':                  'LoopStep › for',
  'announce-pause-bottom-left': 'Step',
  'pause-bottom-left':          'DelayStep',
  'move-up':                    'LoopStep › for',
  'finish-lap':                 'Step',
});

// --- UI helpers ---
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Convert % → arena px (accounting for box size)
function toPixels(pct, arenaSize, boxSize) {
  return (pct / 100) * (arenaSize - boxSize);
}

// --- Box state (percentage positions, 0-100) ---
const pos = { x: 10, y: 10 };
const MOVE_STEP = 10;     // percent per grid step
const STEP_MS = 300;      // ms between each grid step
const CORNER_DELAY = 900; // ms pause at corners

function moveBox(x, y) {
  pos.x = x;
  pos.y = y;
  box.style.left = toPixels(x, arena.clientWidth, box.offsetWidth) + 'px';
  box.style.top  = toPixels(y, arena.clientHeight, box.offsetHeight) + 'px';
}

function flash(on) {
  box.classList.toggle('flash', on);
}

// Lap count lives outside the workflow, since a fresh Workflow (with its own
// state) is built every lap.
let laps = 0;

// --- Workflow factory (recreated each lap) ---
function buildWorkflow() {
  return new Workflow({
    name: 'box-tour',
    steps: [

      // 1. STEP — reset box to top-left
      new Step({
        name: 'initialize',
        callable: async () => {
          status('initialize', 'reset-to-top-left');
          moveBox(10, 10);
          await sleep(600);
        },
      }),

      // 2. LOOP STEP — move right across the top
      new LoopStep({
        name: 'move-right',
        loop_type: 'for',
        iterations: 8,
        callable: async function () {
          const step = this.results.length + 1;
          status('move-right', `iteration ${step} of 8`);
          moveBox(pos.x + MOVE_STEP, pos.y);
          await sleep(STEP_MS);
        },
      }),

      // 3. DELAY STEP — pause at top-right corner
      new Step({
        name: 'announce-pause-top-right',
        callable: async () => {
          status('pause-top-right', 'DelayStep — holding at corner');
        },
      }),
      new DelayStep({
        name: 'pause-top-right',
        delay_type: 'relative',
        relative_delay_ms: CORNER_DELAY,
      }),

      // 4. LOOP STEP — move down the right side
      new LoopStep({
        name: 'move-down',
        loop_type: 'for',
        iterations: 8,
        callable: async function () {
          const step = this.results.length + 1;
          status('move-down', `iteration ${step} of 8`);
          moveBox(pos.x, pos.y + MOVE_STEP);
          await sleep(STEP_MS);
        },
      }),

      // 5. CONDITIONAL STEP — flash box if this is lap 2+
      new ConditionalStep({
        name: 'check-laps',
        conditional: {
          subject: () => laps,
          operator: '>=',
          value: 1,
        },
        true_callable: async () => {
          status('check-laps', 'true-branch — bonus flash!');
          flash(true);
          await sleep(300);
          flash(false);
          await sleep(300);
          flash(true);
          await sleep(300);
          flash(false);
          await sleep(200);
        },
        false_callable: async () => {
          status('check-laps', 'false-branch — first lap, no flash');
          await sleep(400);
        },
      }),

      // 6. LOOP STEP — move left across the bottom
      new LoopStep({
        name: 'move-left',
        loop_type: 'for',
        iterations: 8,
        callable: async function () {
          const step = this.results.length + 1;
          status('move-left', `iteration ${step} of 8`);
          moveBox(pos.x - MOVE_STEP, pos.y);
          await sleep(STEP_MS);
        },
      }),

      // 7. DELAY STEP — pause at bottom-left corner
      new Step({
        name: 'announce-pause-bottom-left',
        callable: async () => {
          status('pause-bottom-left', 'DelayStep — holding at corner');
        },
      }),
      new DelayStep({
        name: 'pause-bottom-left',
        delay_type: 'relative',
        relative_delay_ms: CORNER_DELAY,
      }),

      // 8. LOOP STEP — move up the left side
      new LoopStep({
        name: 'move-up',
        loop_type: 'for',
        iterations: 8,
        callable: async function () {
          const step = this.results.length + 1;
          status('move-up', `iteration ${step} of 8`);
          moveBox(pos.x, pos.y - MOVE_STEP);
          await sleep(STEP_MS);
        },
      }),

      // 9. STEP — finish lap, increment counter
      new Step({
        name: 'finish-lap',
        callable: async () => {
          laps += 1;
          status('finish-lap', `completed lap ${laps}`);
          lapsEl.textContent = laps;
          await sleep(600);
        },
      }),
    ],
  });
}

// --- Main loop ---
async function run() {
  while (true) {
    const wf = buildWorkflow();
    await wf.execute();
    await sleep(300);
  }
}

run().catch(console.error);
