import { Workflow, Step } from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { createServerStatus } from './server-status.js';
import { badgeFor } from './launch-feed.js';

const $ = (id) => document.getElementById(id);
const formEl = $('job-form');
const taskEl = $('task');
const messageEl = $('message');
const limitEl = $('limit');
const delayEl = $('delay');
const errorEl = $('form-error');
const sourceEl = $('board-source');

const status = createStatusPanel();
const server = createServerStatus({ demo: 'scheduler' });

const TASK_TITLES = { deliver: 'deliver', dice: 'roll 3d6', primes: 'count primes' };
const RING = 2 * Math.PI * 12;

// The top-right panel follows this page's own (browser-side) workflow.
let current = null;
Workflow.events.step.on('step_running', (step) => {
  current = { name: step.name, badge: badgeFor(step) };
  status(step.name, 'running', current.badge);
});
const note = (text) => current && status(current.name, text, current.badge);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- Board ---
let jobs = [];
let clock_offset = 0; // server time − local time

const serverNow = () => Date.now() + clock_offset;

function ring(job) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 30 30');
  svg.classList.add('ring');
  svg.innerHTML = '<circle class="track" cx="15" cy="15" r="12"></circle>' +
    `<circle class="arc" cx="15" cy="15" r="12" stroke-dasharray="${RING}"></circle><text x="15" y="15"></text>`;
  svg.dataset.runAt = job.run_at;
  svg.dataset.total = job.run_at - job.created_at;
  return svg;
}

function card(job) {
  const state = job.status === 'waiting' || job.status === 'scheduled' ? 'waiting' : job.status;
  const li = el('li', `card ${state}`);
  const head = el('div', 'card-head');
  if (state === 'waiting') head.append(ring(job));
  if (state === 'running') head.append(el('span', 'spinner'));
  head.append(el('span', 'card-task', TASK_TITLES[job.task] ?? job.task), el('span', 'card-id', job.id));
  li.append(head);

  if (job.task === 'deliver' && state !== 'done') li.append(el('div', 'card-message', job.message));
  if (job.task === 'primes' && state !== 'done') li.append(el('div', 'card-message', `below ${job.limit.toLocaleString('en-US')}`));

  if (state === 'waiting') {
    li.append(el('div', 'card-detail', `runs at ${new Date(job.run_at).toLocaleTimeString([], { hour12: false })}`));
  }
  if (state === 'done' && job.result) {
    li.append(el('div', 'card-result', job.result.text), el('div', 'card-detail', job.result.detail));
    li.append(el('div', 'card-detail', `finished ${new Date(job.finished_at).toLocaleTimeString([], { hour12: false })} · task ran ${job.finished_at - job.started_at} ms`));
  }
  if (state === 'failed') li.append(el('div', 'card-result', job.error ?? 'failed'));
  return li;
}

function renderBoard() {
  const columns = { waiting: [], running: [], done: [] };
  for (const job of jobs) {
    const state = job.status === 'waiting' || job.status === 'scheduled' ? 'waiting' : job.status === 'running' ? 'running' : 'done';
    columns[state].push(job);
  }
  columns.done.reverse(); // newest first

  for (const [name, list] of Object.entries(columns)) {
    const col = $(`col-${name}`);
    col.replaceChildren(...(list.length ? list.map(card) : [el('li', 'empty', name === 'waiting' ? 'Nothing scheduled.' : name === 'running' ? 'Idle.' : 'No results yet.')]));
    $(`count-${name}`).textContent = list.length;
  }
  tick();
}

// Countdown rings, against the server's clock.
function tick() {
  for (const svg of document.querySelectorAll('.ring')) {
    const left = Math.max(0, Number(svg.dataset.runAt) - serverNow());
    const fraction = Math.min(1, left / Number(svg.dataset.total));
    svg.querySelector('.arc').setAttribute('stroke-dashoffset', String(RING * (1 - fraction)));
    svg.querySelector('text').textContent = `${Math.ceil(left / 1000)}`;
  }
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

let refreshing = null;
async function refresh() {
  refreshing ??= (async () => {
    try {
      const data = await api('GET', '/api/scheduler/jobs');
      clock_offset = data.server_time - Date.now();
      jobs = data.jobs;
      sourceEl.textContent = `GET /api/scheduler/jobs · ${jobs.length} jobs · ${new Date().toLocaleTimeString([], { hour12: false })}`;
      renderBoard();
    } catch (error) {
      sourceEl.textContent = `GET /api/scheduler/jobs failed: ${error.message}`;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// --- Client-side workflow: validate, POST, refresh ---
let scheduled = 0;
let draft = null;

const client = new Workflow({
  name: 'schedule-job-client',
  exit_on_error: true,
  steps: [
    new Step({
      name: 'validate-form',
      callable: async () => {
        draft = {
          task: taskEl.value,
          message: messageEl.value.trim(),
          limit: Number(limitEl.value),
          delay_seconds: Number(delayEl.value),
        };
        if (draft.task === 'deliver' && !draft.message) throw new Error('Write a message to deliver.');
        note(`${draft.task} in ${draft.delay_seconds} s`);
      },
    }),
    new Step({
      name: 'post-job',
      callable: async () => {
        const { job } = await api('POST', '/api/scheduler/jobs', draft);
        note(`POST /api/scheduler/jobs → 201 job ${job.id}`);
      },
    }),
    new Step({
      name: 'refresh-board',
      callable: async () => {
        await refresh();
        note(`GET /api/scheduler/jobs → ${jobs.length} jobs`);
      },
    }),
  ],
});

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  $('schedule').disabled = true;
  errorEl.hidden = true;
  try {
    await client.execute();
    if (client.status === 'failed') {
      const error = client.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message ?? 'failed';
      errorEl.textContent = error;
      errorEl.hidden = false;
      status(client.name, `failed — ${error}`, 'Workflow › failed');
    } else {
      scheduled += 1;
      $('scheduled-count').textContent = scheduled;
      status(client.name, 'complete — job scheduled on the server', 'Workflow › complete');
    }
  } finally {
    $('schedule').disabled = false;
  }
});

taskEl.addEventListener('change', () => {
  $('message-field').hidden = taskEl.value !== 'deliver';
  $('limit-field').hidden = taskEl.value !== 'primes';
});
delayEl.addEventListener('input', () => { $('delay-label').textContent = `${delayEl.value} s`; });

$('clear-done').addEventListener('click', async () => {
  await api('DELETE', '/api/scheduler/jobs?finished=1');
  refresh();
});

// Refresh on a timer, and right away when the server says a job changed state.
server.onEvent((m) => {
  if (m.kind === 'workflow' || m.name === 'run-task') refresh();
});
setInterval(refresh, 2000);
setInterval(tick, 250);
refresh();
