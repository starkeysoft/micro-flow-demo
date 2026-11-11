import { Workflow, Step } from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { createServerStatus } from './server-status.js';
import { badgeFor } from './launch-feed.js';

const $ = (id) => document.getElementById(id);
const responseEl = $('response-line');
const sourceEl = $('source');

const status = createStatusPanel();
const server = createServerStatus({ demo: 'webhooks' });

const EVENT_TYPES = ['order.created', 'payment.succeeded', 'payment.failed', 'customer.updated', 'invoice.finalized'];

// The top-right panel follows this page's own (browser-side) workflows.
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

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok && !data.results) throw new Error(data.error ?? `HTTP ${res.status}`);
  return { status: res.status, data };
}

// --- Rendering ---
let state = null;

const VERDICT_LABEL = { accepted: '202', duplicate: '200 dup', rejected: '4xx' };

function handlerChips(handlers) {
  const chips = el('span', 'chips');
  for (const h of handlers) {
    const chip = el('span', `chip ${h.status}`, h.name);
    if (h.attempts > 1) chip.append(el('sup', '', `×${h.attempts}`));
    chip.title = `${h.status}${h.ms != null ? ` · ${h.ms} ms` : ''}${h.error ? ` · ${h.error}` : ''}`;
    chips.append(chip);
  }
  return chips;
}

function deliveryRow(d) {
  const li = el('li', `entry ${d.status}`);
  const verdict = d.verdict === 'rejected'
    ? (/queue full/.test(d.reason) ? '429' : /JSON/.test(d.reason) ? '400' : '401')
    : VERDICT_LABEL[d.verdict];
  const head = el('div', 'entry-head');
  head.append(
    el('span', `pill ${d.verdict}`, verdict),
    el('span', 'entry-type', d.type ?? '(unreadable)'),
    el('span', `state ${d.status}`, d.status),
    el('span', 'entry-time', time(d.received_at)),
  );
  li.append(head);

  const meta = [d.event_id ?? '—'];
  if (d.source === 'http') meta.push('via HTTP');
  if (d.reason) meta.push(d.reason);
  if (d.worker && d.status !== 'queued') meta.push(d.worker);
  if (d.runs > 1) meta.push(`${d.runs} runs`);
  if (d.finished_at && d.started_at) meta.push(`${d.finished_at - d.started_at} ms`);
  if (d.note) meta.push(d.note);
  li.append(el('div', 'entry-meta', meta.join(' · ')));
  if (d.handlers.length) li.append(handlerChips(d.handlers));
  return li;
}

function renderLanes() {
  $('lanes').replaceChildren(...state.workers.map((w) => {
    const lane = el('div', `lane ${w.current ? 'busy' : ''}`);
    const head = el('div', 'lane-head');
    head.append(el('span', 'lane-name', w.name), el('span', 'lane-count', `${w.processed} done`));
    lane.append(head);
    if (w.current) {
      lane.append(el('div', 'lane-event', w.current.type), el('div', 'entry-meta', w.current.event_id));
      if (w.current.handlers.length) lane.append(handlerChips(w.current.handlers));
    } else {
      lane.append(el('div', 'lane-idle', 'idle — waiting for the queue'));
    }
    return lane;
  }));

  $('queue-depth').textContent = state.queue.length;
  $('queue-chips').replaceChildren(...state.queue.map((q) => el('li', 'queue-chip', q.type)));
}

function renderDead() {
  const list = $('dead-list');
  if (!state.dead.length) {
    list.replaceChildren(el('li', 'empty', 'Nothing here. Turn on CRM outage and send customer.updated.'));
    return;
  }
  list.replaceChildren(...state.dead.map((d) => {
    const li = el('li', 'dead-item');
    const text = el('div', 'dead-text');
    text.append(el('span', 'entry-type', d.type), el('div', 'entry-meta', `${d.event_id} · ${d.error} · ${d.runs} run${d.runs === 1 ? '' : 's'}`));
    const button = el('button', 'button ghost small', 'Redeliver');
    button.type = 'button';
    button.addEventListener('click', () => redeliver(d.id, button));
    li.append(text, button);
    return li;
  }));
}

function render() {
  for (const key of ['crm_outage', 'flaky_email']) $(key).checked = state.settings[key];
  renderLanes();
  renderDead();
  $('log').replaceChildren(...(state.deliveries.length ? state.deliveries.map(deliveryRow) : [el('li', 'empty', 'No deliveries yet.')]));
}

let refreshing = null;
function refresh() {
  refreshing ??= (async () => {
    try {
      ({ data: state } = await api('GET', '/api/webhooks/state'));
      sourceEl.textContent = `GET /api/webhooks/state · ${state.deliveries.length} deliveries · ${time(Date.now())}`;
      render();
    } catch (error) {
      sourceEl.textContent = `GET /api/webhooks/state failed: ${error.message}`;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// --- Client-side workflow: build the request, POST it, refresh the inbox ---
let request = null;
let response = null;
let sent = 0;

const refreshStep = () => new Step({
  name: 'refresh-inbox',
  callable: async () => {
    await refresh();
    note(`GET /api/webhooks/state → queue ${state?.queue.length ?? '?'}`);
  },
});

const sendClient = new Workflow({
  name: 'send-webhook-client',
  exit_on_error: true,
  steps: [
    new Step({
      name: 'build-request',
      callable: async () => {
        note(`${request.mode === 'normal' ? request.type : request.mode}`);
      },
    }),
    new Step({
      name: 'post-simulate',
      callable: async () => {
        response = await api('POST', '/api/webhooks/simulate', request);
        const codes = response.data.results.map((r) => r.status);
        const summary = codes.length > 1
          ? `${codes.length} deliveries: ${codes.join(', ')}`
          : `${codes[0]} ${JSON.stringify(response.data.results[0])}`;
        responseEl.textContent = `POST /api/webhooks/simulate → ${summary}`;
        responseEl.className = `response-line ${codes.every((c) => c < 300) ? 'good' : 'bad'}`;
        note(`receiver → ${codes.join(', ')}`);
      },
    }),
    refreshStep(),
  ],
});

const redeliverClient = new Workflow({
  name: 'redeliver-client',
  exit_on_error: true,
  steps: [
    new Step({
      name: 'post-redeliver',
      callable: async () => {
        const { status: code } = await api('POST', `/api/webhooks/deliveries/${request.id}/redeliver`);
        note(`POST …/${request.id}/redeliver → ${code}`);
      },
    }),
    refreshStep(),
  ],
});

async function run(client, after) {
  document.body.classList.add('sending');
  try {
    await client.execute();
    if (client.status === 'failed') {
      const error = client.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message ?? 'failed';
      responseEl.textContent = error;
      responseEl.className = 'response-line bad';
      status(client.name, `failed — ${error}`, 'Workflow › failed');
    } else {
      after?.();
      status(client.name, 'complete', 'Workflow › complete');
    }
  } finally {
    document.body.classList.remove('sending');
  }
}

function send(type, mode) {
  if (sendClient.status === 'running') return;
  request = { type, mode };
  run(sendClient, () => {
    sent += response.data.results.length;
    $('sent-count').textContent = sent;
  });
}

function redeliver(id, button) {
  if (redeliverClient.status === 'running') return;
  button.disabled = true;
  request = { id };
  run(redeliverClient);
}

// --- Console ---
for (const type of EVENT_TYPES) {
  const button = el('button', 'button ghost small event', type);
  button.type = 'button';
  if (type === 'invoice.finalized') button.title = 'No handler is registered for this type';
  button.addEventListener('click', () => send(type, 'normal'));
  $('event-buttons').append(button);
}
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => send('customer.updated', button.dataset.mode));
}
for (const key of ['crm_outage', 'flaky_email']) {
  $(key).addEventListener('change', async () => {
    await api('POST', '/api/webhooks/settings', { [key]: $(key).checked });
    refresh();
  });
}
$('clear-log').addEventListener('click', async () => {
  await api('DELETE', '/api/webhooks/deliveries');
  refresh();
});

// A copy-and-paste curl request against this server.
const curl = `SECRET=whsec_demo_microflow
T=$(date +%s)
BODY='{"id":"evt_curl_'$T'","type":"customer.updated","created":'$T',"data":{"customer":{"id":"cus_1","email":"ada@example.com"}}}'
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -i ${location.origin}/api/webhooks/receive \\
  -H 'content-type: application/json' \\
  -H "paystream-signature: t=$T,v1=$SIG" \\
  -d "$BODY"`;
$('curl').textContent = curl;
$('copy-curl').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(curl);
    $('copy-curl').textContent = 'Copied';
  } catch {
    // Clipboard needs HTTPS or localhost; select the text instead.
    getSelection().selectAllChildren($('curl'));
    $('copy-curl').textContent = 'Selected';
  }
  setTimeout(() => { $('copy-curl').textContent = 'Copy'; }, 1500);
});

// Refresh soon after server events (debounced), and on a timer.
let pending = null;
server.onEvent(() => {
  pending ??= setTimeout(() => { pending = null; refresh(); }, 250);
});
setInterval(refresh, 2000);
refresh();
