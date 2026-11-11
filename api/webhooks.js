// webhook-inbox: a signed webhook receiver. A fictional payment provider,
// "Paystream", signs each event with HMAC-SHA256. The receiver verifies the
// signature and timestamp, drops duplicates by event id, acks with 202 and
// queues the event. Two worker workflows drain the queue; each event runs in
// its own workflow that routes on the event type to a nested workflow of
// handlers. Events whose handlers keep failing land in a dead-letter queue and
// can be redelivered, which re-runs the same workflow.
import express from 'express';
import crypto from 'crypto';
import { Workflow, Step, LoopStep, SwitchStep, Case } from '@ronaldroe/micro-flow';
import { track, forget } from './server-status.js';

export const router = express.Router();

const DEMO = 'webhooks';
export const SECRET = 'whsec_demo_microflow'; // published on purpose: it's a demo
const SIGNATURE_HEADER = 'paystream-signature';
const TOLERANCE_S = 5 * 60;
const MAX_QUEUE = 30;
const MAX_LOG = 40;
const MAX_SEEN = 500;
const HANDLER_RETRIES = 2;

const settings = { crm_outage: false, flaky_email: false };
const deliveries = []; // newest first
const seen = new Map(); // event id → delivery that accepted it
const queue = []; // deliveries waiting for a worker
let last_event = null; // { body } of the last event the console sent, for "duplicate"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const shortId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// --- Signing (provider side) and verification (receiver side) ---
export function sign(body, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function verify(raw, header) {
  if (!header) return 'missing signature header';
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return 'malformed signature header';

  const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'))) return 'signature mismatch';
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_S) return 'timestamp outside 5 min tolerance';
  return null;
}

// --- Handlers: each a simulated downstream call ---
class Downstream extends Error {}

const HANDLERS = {
  'reserve-stock': async () => {},
  'send-confirmation': async () => { if (settings.flaky_email && Math.random() < 0.4) throw new Downstream('email API 502'); },
  'notify-slack': async () => {},
  'mark-paid': async () => {},
  'send-receipt': async () => { if (settings.flaky_email && Math.random() < 0.4) throw new Downstream('email API 502'); },
  'mark-unpaid': async () => {},
  'email-dunning': async () => { if (settings.flaky_email && Math.random() < 0.4) throw new Downstream('email API 502'); },
  'sync-crm': async () => {
    if (settings.crm_outage) throw new Downstream('CRM API 503 Service Unavailable');
  },
};

const ROUTES = {
  'order.created': ['reserve-stock', 'send-confirmation', 'notify-slack'],
  'payment.succeeded': ['mark-paid', 'send-receipt'],
  'payment.failed': ['mark-unpaid', 'email-dunning'],
  'customer.updated': ['sync-crm'],
};
export const EVENT_TYPES = [...Object.keys(ROUTES), 'invoice.finalized']; // the last one has no route

// One handler step. Retries back off exponentially inside the callable, and a
// handler that already succeeded on an earlier run is skipped (idempotent).
function handlerStep(delivery, name) {
  const record = { name, status: 'pending', attempts: 0, ms: null, error: null };
  // Every case's body is built, but only the routed type's handlers are listed.
  if (ROUTES[delivery.type]?.includes(name)) delivery.handlers.push(record);

  const step = new Step({
    name,
    max_retries: HANDLER_RETRIES,
    max_timeout_ms: 5000,
    callable: async () => {
      if (record.status === 'done' || record.status === 'skipped') {
        record.status = 'skipped';
        return 'already done';
      }
      if (step.retry_count > 0) await sleep(250 * 2 ** (step.retry_count - 1)); // 250, 500 ms
      record.status = 'running';
      record.attempts += 1;
      const started = performance.now();
      try {
        await sleep(rand(200, 700));
        await HANDLERS[name]();
        record.status = 'done';
        record.error = null;
        return 'ok';
      } catch (error) {
        record.status = step.retry_count < HANDLER_RETRIES ? 'retrying' : 'failed';
        record.error = error.message;
        throw error;
      } finally {
        record.ms = Math.round(performance.now() - started);
      }
    },
  });
  return step;
}

function buildEventWorkflow(delivery) {
  const bodies = [];
  const cases = Object.entries(ROUTES).map(([type, names]) => {
    const body = new Workflow({
      name: `handle:${type}`,
      exit_on_error: true,
      steps: names.map((name) => handlerStep(delivery, name)),
    });
    bodies.push(body);
    return new Case({ name: type, conditional: { operator: '===', value: type }, callable: body });
  });

  const workflow = new Workflow({
    name: `webhook:${delivery.event_id}`,
    exit_on_error: true,
    steps: [
      new Step({
        name: 'parse',
        callable: async () => {
          delivery.event = JSON.parse(delivery.raw);
          return delivery.event.type;
        },
      }),
      new SwitchStep({
        name: 'route',
        subject: () => delivery.event.type,
        cases,
        default_callable: async () => {
          delivery.handlers.push({ name: 'log-unhandled', status: 'done', attempts: 1, ms: 0, error: null });
          delivery.note = `no handler for ${delivery.event.type}, acknowledged and logged`;
          return 'unhandled';
        },
      }),
    ],
  });
  // Only the matching case's body runs, but every body is a nested workflow:
  // tag them all so their step events reach the Server Status panel.
  for (const body of bodies) track(body, DEMO, delivery.event_id);
  delivery.bodies = bodies;
  return workflow;
}

async function runEvent(delivery) {
  delivery.status = 'processing';
  delivery.started_at = Date.now();
  await delivery.workflow.execute();
  delivery.runs = Object.keys(delivery.workflow.sessions).length;
  // A redelivered event runs its bodies again; their snapshots shouldn't carry old runs.
  for (const body of delivery.bodies) body.sessions = {};
  delivery.finished_at = Date.now();
  if (delivery.workflow.status === 'failed') {
    delivery.status = 'dead';
    delivery.error = delivery.handlers.find((h) => h.status === 'failed')?.error ?? 'failed';
  } else {
    delivery.status = 'done';
    delivery.error = null;
  }
}

// --- Workers: each a workflow whose while loop drains the queue ---
function buildWorker(name) {
  const worker = { name, current: null, busy: false, processed: 0 };
  worker.workflow = new Workflow({
    name,
    steps: [
      new LoopStep({
        name: 'drain',
        loop_type: 'while',
        conditional: { subject: () => queue.length, operator: '>', value: 0 },
        max_iterations: 10_000,
        max_timeout_ms: null,
        callable: async function () {
          const delivery = queue.shift();
          if (!delivery) return null; // the other worker took it
          worker.current = delivery;
          delivery.worker = name;
          try {
            await runEvent(delivery);
          } finally {
            worker.current = null;
            worker.processed++;
          }
          return delivery.event_id;
        },
      }),
    ],
  });
  track(worker.workflow, DEMO, name);
  return worker;
}

// Built on first use: at import time server.js hasn't turned off micro-flow's console logging yet.
let pool = null;
const workers = () => (pool ??= [buildWorker('worker-1'), buildWorker('worker-2')]);

// Re-run every idle worker. `busy` covers the gap between the loop's last
// condition check and the workflow being marked complete.
function kick() {
  for (const worker of workers()) {
    if (worker.busy || !queue.length) continue;
    worker.busy = true;
    worker.workflow.execute()
      .catch(() => {})
      .finally(() => {
        worker.busy = false;
        if (queue.length) kick();
      });
  }
}

// --- Receiver ---
function drop(i) {
  const [d] = deliveries.splice(i, 1);
  if (d.workflow) {
    forget(d.workflow);
    for (const body of d.bodies) forget(body);
  }
}

function record(delivery) {
  deliveries.unshift(delivery);
  // Trim old finished deliveries, keeping queued, processing and dead ones;
  // past twice the cap, old dead letters go too.
  for (let i = deliveries.length - 1; i >= 0 && deliveries.length > MAX_LOG; i--) {
    if (['done', 'ignored', 'rejected'].includes(deliveries[i].status)) drop(i);
  }
  for (let i = deliveries.length - 1; i >= 0 && deliveries.length > MAX_LOG * 2; i--) {
    if (deliveries[i].status === 'dead') drop(i);
  }
}

function receive(raw, header, source) {
  const delivery = {
    id: shortId('dlv'),
    event_id: null,
    type: null,
    source,
    received_at: Date.now(),
    verdict: null,
    reason: null,
    status: null,
    handlers: [],
    runs: 0,
    worker: null,
    note: null,
    error: null,
    started_at: null,
    finished_at: null,
  };

  const reject = (code, reason) => {
    Object.assign(delivery, { verdict: 'rejected', reason, status: 'rejected' });
    record(delivery);
    return { code, body: { error: reason, delivery: delivery.id } };
  };

  const problem = verify(raw, header);
  let event = null;
  try { event = JSON.parse(raw); } catch { /* reported below */ }
  delivery.event_id = typeof event?.id === 'string' ? event.id.slice(0, 40) : null;
  delivery.type = typeof event?.type === 'string' ? event.type.slice(0, 40) : null;

  if (problem) return reject(401, problem);
  if (!delivery.event_id || !delivery.type) return reject(400, 'body must be JSON with string "id" and "type"');

  if (seen.has(delivery.event_id)) {
    Object.assign(delivery, { verdict: 'duplicate', reason: `already received as ${seen.get(delivery.event_id).id}`, status: 'ignored' });
    record(delivery);
    return { code: 200, body: { received: true, duplicate: true, delivery: delivery.id } };
  }
  if (queue.length >= MAX_QUEUE) return reject(429, `queue full (${MAX_QUEUE})`);

  Object.assign(delivery, { verdict: 'accepted', status: 'queued' });
  delivery.raw = raw;
  delivery.workflow = buildEventWorkflow(delivery);
  track(delivery.workflow, DEMO, delivery.event_id, { top: true });

  seen.set(delivery.event_id, delivery);
  if (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);

  record(delivery);
  queue.push(delivery);
  kick();
  return { code: 202, body: { received: true, delivery: delivery.id } };
}

// The receiver needs the exact bytes that were signed. server.js's
// express.json() keeps them in req.raw_body (its verify hook); requests with
// another content type reach express.raw() here as a Buffer.
router.post('/webhooks/receive', express.raw({ type: () => true, limit: '16kb' }), (req, res) => {
  const raw = req.raw_body ?? (Buffer.isBuffer(req.body) ? req.body : null);
  if (!raw) return res.status(400).json({ error: 'raw body unavailable' });
  const { code, body } = receive(raw.toString('utf8'), req.get(SIGNATURE_HEADER), 'http');
  res.status(code).json(body);
});

// --- Provider console: build, sign and deliver events ---
const NAMES = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Linus Torvalds', 'Margaret Hamilton'];

function buildEvent(type) {
  const name = pick(NAMES);
  const customer = { id: shortId('cus'), name, email: `${name.split(' ')[0].toLowerCase()}@example.com` };
  const amount = rand(900, 25000);
  const data = {
    'order.created': { order: { id: shortId('ord'), customer: customer.id, amount, currency: 'usd', items: rand(1, 4) } },
    'payment.succeeded': { payment: { id: shortId('pay'), amount, currency: 'usd', customer: customer.id } },
    'payment.failed': { payment: { id: shortId('pay'), amount, currency: 'usd', customer: customer.id, failure: 'card_declined' } },
    'customer.updated': { customer },
    'invoice.finalized': { invoice: { id: shortId('inv'), amount, customer: customer.id } },
  }[type];
  return JSON.stringify({ id: shortId('evt'), type, created: Math.floor(Date.now() / 1000), data });
}

function simulate(type, mode) {
  if (mode === 'duplicate') {
    if (!last_event) return [{ code: 409, body: { error: 'Send an event first, then resend it.' } }];
    return [receive(last_event, sign(last_event), 'console')];
  }
  if (mode === 'burst') {
    return Array.from({ length: 8 }, () => {
      const body = buildEvent(pick(EVENT_TYPES));
      last_event = body;
      return receive(body, sign(body), 'console');
    });
  }

  const body = buildEvent(type);
  if (mode === 'tampered') {
    const header = sign(body);
    // Change the body after signing: bump the amount, or the email if there's no amount.
    const forged = body.includes('"amount":')
      ? body.replace(/"amount":(\d+)/, (_, n) => `"amount":${Number(n) * 100}`)
      : body.replace(/"email":"[^"]*"/, '"email":"attacker@example.net"');
    return [receive(forged, header, 'console')];
  }
  if (mode === 'stale') return [receive(body, sign(body, Math.floor(Date.now() / 1000) - 10 * 60), 'console')];
  last_event = body;
  return [receive(body, sign(body), 'console')];
}

router.post('/webhooks/simulate', (req, res) => {
  const { type = 'order.created', mode = 'normal' } = req.body ?? {};
  if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: `Unknown event type "${type}".` });
  if (!['normal', 'duplicate', 'tampered', 'stale', 'burst'].includes(mode)) return res.status(400).json({ error: `Unknown mode "${mode}".` });
  const results = simulate(type, mode);
  res.status(results.length === 1 ? results[0].code : 200).json({ results: results.map((r) => ({ status: r.code, ...r.body })) });
});

router.post('/webhooks/settings', (req, res) => {
  for (const key of Object.keys(settings)) {
    if (typeof req.body?.[key] === 'boolean') settings[key] = req.body[key];
  }
  res.json({ settings });
});

router.post('/webhooks/deliveries/:id/redeliver', (req, res) => {
  const delivery = deliveries.find((d) => d.id === req.params.id);
  if (!delivery) return res.status(404).json({ error: 'No such delivery.' });
  if (delivery.status !== 'dead') return res.status(409).json({ error: 'Only dead-lettered deliveries can be redelivered.' });
  if (queue.length >= MAX_QUEUE) return res.status(429).json({ error: `Queue full (${MAX_QUEUE}).` });
  delivery.status = 'queued';
  queue.push(delivery);
  kick();
  res.status(202).json({ delivery: delivery.id });
});

router.delete('/webhooks/deliveries', (req, res) => {
  let removed = 0;
  for (let i = deliveries.length - 1; i >= 0; i--) {
    if (['done', 'ignored', 'rejected'].includes(deliveries[i].status)) {
      drop(i);
      removed++;
    }
  }
  res.json({ removed });
});

const publicDelivery = ({ workflow, bodies, raw, event, ...d }) => d;

router.get('/webhooks/state', (req, res) => {
  res.json({
    server_time: Date.now(),
    secret: SECRET,
    header: SIGNATURE_HEADER,
    settings,
    event_types: EVENT_TYPES,
    queue: queue.map((d) => ({ id: d.id, event_id: d.event_id, type: d.type })),
    workers: workers().map((w) => ({
      name: w.name,
      busy: w.busy,
      processed: w.processed,
      status: w.workflow.status,
      current: w.current && { id: w.current.id, event_id: w.current.event_id, type: w.current.type, handlers: w.current.handlers },
    })),
    deliveries: deliveries.map(publicDelivery),
    dead: deliveries.filter((d) => d.status === 'dead').map(publicDelivery),
  });
});
