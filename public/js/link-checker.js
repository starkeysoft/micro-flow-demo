import { Workflow, Step, LoopStep } from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { createServerStatus } from './server-status.js';
import { badgeFor } from './launch-feed.js';

const $ = (id) => document.getElementById(id);
const urlsEl = $('urls');
const checkBtn = $('check');
const reportEl = $('report');
const summaryEl = $('summary');
const requestEl = $('request-line');

const status = createStatusPanel();
createServerStatus({ demo: 'link-check' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// --- Report ---
const PILLS = {
  ok: (r) => String(r.status),
  redirect: (r) => `${r.first_status}→${r.status}`,
  broken: (r) => String(r.status),
  timeout: () => 'timeout',
  dns: () => 'DNS',
  blocked: () => 'blocked',
  invalid: () => 'invalid',
  error: () => 'error',
};

function renderReport(job) {
  const slowest = Math.max(1, ...job.results.map((r) => r.ms ?? 0));
  reportEl.replaceChildren();
  for (const row of job.results) {
    const li = el('li', 'row');
    const done = row.state === 'done';
    const pill = el('span', `pill ${done ? row.kind : row.state === 'checking' ? 'checking' : ''}`,
      done ? PILLS[row.kind]?.(row) ?? row.kind : row.state === 'checking' ? 'checking…' : 'queued');

    const latency = el('span', 'latency');
    const bar = el('span', 'latency-bar');
    const fill = el('span');
    fill.style.width = row.ms != null ? `${Math.max(3, (row.ms / slowest) * 100)}%` : '0%';
    bar.append(fill);
    latency.append(bar, el('span', '', row.ms != null ? `${row.ms} ms` : ''));

    const meta = [];
    if (row.final_url && row.final_url !== row.url) meta.push(`→ ${row.final_url}`);
    if (row.content_type) meta.push(row.content_type);
    if (row.error) meta.push(row.error);
    if (row.attempts > 1) meta.push(`${row.attempts} attempts`);

    li.append(pill, el('span', 'row-url', row.url), latency);
    if (meta.length) li.append(el('span', 'row-meta', meta.join(' · ')));
    reportEl.append(li);
  }
}

function renderSummary(job) {
  const s = job.summary ?? {};
  summaryEl.replaceChildren(
    ...[['ok', 'ok'], ['redirect', 'redirected'], ['broken', 'broken'], ['failed', 'failed']].map(([k, label]) => {
      const span = el('span', k);
      span.append(el('b', '', s[k] ?? 0), ` ${label}`);
      return span;
    }),
    el('span', '', `server time ${((job.finished_at - job.created_at) / 1000).toFixed(1)} s`),
  );
  summaryEl.hidden = false;
}

// --- Client-side workflow: submit, poll, render ---
let job = null;
let job_id = null;
let checks = 0;

async function api(method, url, body) {
  requestEl.textContent = `${method} ${url}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  requestEl.textContent = `${method} ${url} → ${res.status}`;
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const client = new Workflow({
  name: 'check-links-client',
  exit_on_error: true,
  steps: [
    new Step({
      name: 'submit-job',
      callable: async () => {
        const urls = urlsEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
        ({ id: job_id } = await api('POST', '/api/link-check', { urls }));
        note(`POST /api/link-check → job ${job_id}`);
      },
    }),
    new LoopStep({
      name: 'poll-job',
      loop_type: 'while',
      conditional: { subject: () => job?.status ?? 'queued', operator: 'not_in', value: ['done', 'error'] },
      max_iterations: 400,
      max_timeout_ms: 3 * 60 * 1000,
      callable: async function () {
        job = await api('GET', `/api/link-check/${job_id}`);
        renderReport(job);
        const finished = job.results.filter((r) => r.state === 'done').length;
        note(`poll ${this.results.length + 1}: ${job.status} (${finished}/${job.results.length})`);
        if (job.status !== 'done') await sleep(400);
      },
    }),
    new Step({
      name: 'render-summary',
      callable: async () => {
        if (job.status === 'error') throw new Error(job.error ?? 'server check failed');
        renderSummary(job);
        note(`${job.summary.ok + job.summary.redirect} of ${job.results.length} reachable`);
      },
    }),
  ],
});

checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  job = null;
  summaryEl.hidden = true;
  reportEl.innerHTML = '<li class="empty">Waiting for the server…</li>';
  try {
    await client.execute();
    if (client.status === 'failed') {
      const error = client.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message;
      reportEl.innerHTML = '';
      reportEl.append(el('li', 'empty', `Check failed: ${error}`));
      status(client.name, `failed — ${error}`, 'Workflow › failed');
    } else {
      checks += 1;
      $('check-count').textContent = checks;
      status(client.name, `complete — job ${job_id}`, 'Workflow › complete');
    }
  } finally {
    checkBtn.disabled = false;
  }
});
