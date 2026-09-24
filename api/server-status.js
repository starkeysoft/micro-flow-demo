// Bridges the server's micro-flow event bus to browsers over Server-Sent
// Events, one stream per demo. The API modules call track() on the workflows
// and standalone steps they create, so each event can be tagged with the demo
// (and job) it belongs to. Only a small summary of each event is sent; the
// full payloads carry results and sessions.
import express from 'express';
import { Workflow } from '@ronaldroe/micro-flow';

export const router = express.Router();

const owners = new Map();  // workflow/step id → { demo, job }
const top_level = new Map(); // top-level workflow id → demo
const running = new Map();   // demo → Set of running top-level workflow ids
const clients = new Set();   // { res, demo }
const recent = new Map();    // demo → last few messages, replayed to new clients
const RECENT = 12;

export function track(obj, demo, job = null, { top = false } = {}) {
  owners.set(obj.id, { demo, job });
  for (const step of obj.steps ?? []) owners.set(step.id, { demo, job });
  if (top) top_level.set(obj.id, demo);
}

export function forget(obj) {
  owners.delete(obj.id);
  top_level.delete(obj.id);
  for (const step of obj.steps ?? []) owners.delete(step.id);
}

export function activeCount(demo) {
  return running.get(demo)?.size ?? 0;
}

function ownerOf(detail) {
  return owners.get(detail?.id) ??
    owners.get(detail?.parent_workflow_id) ??
    owners.get(detail?.workflow?.id) ??
    null;
}

function send(demo, message) {
  const frame = `data: ${JSON.stringify(message)}\n\n`;
  const list = recent.get(demo) ?? [];
  list.push(frame);
  if (list.length > RECENT) list.shift();
  recent.set(demo, list);
  for (const client of clients) {
    if (client.demo === demo) client.res.write(frame);
  }
}

function summarize(kind, event_name, detail, owner) {
  // Workflow events carry the workflow; skip/break carry { workflow, step };
  // pause/resume carry the instance state ({ workflow, ... }).
  const subject = kind === 'workflow' && !detail.steps ? detail.workflow ?? detail : detail;
  return {
    kind,
    event: event_name,
    job: owner.job,
    id: subject.id,
    name: subject.name,
    class_name: subject.class_name ?? null,
    loop_type: subject.loop_type ?? null,
    delay_type: subject.delay_type ?? null,
    callable_type: subject.callable_type ?? null,
    status: subject.status ?? null,
    retry_count: subject.retry_count ?? 0,
    ms: subject.timing?.execution_time_ms ?? null,
    at: Date.now(),
  };
}

for (const event_name of Object.values(Workflow.event_names.workflow)) {
  Workflow.events.workflow.on(event_name, (detail) => {
    const owner = ownerOf(detail);
    if (!owner) return;
    const message = summarize('workflow', event_name, detail, owner);

    const top_demo = top_level.get(message.id);
    if (top_demo) {
      if (!running.has(top_demo)) running.set(top_demo, new Set());
      if (event_name === 'workflow_running') running.get(top_demo).add(message.id);
      if (event_name === 'workflow_complete' || event_name === 'workflow_failed') running.get(top_demo).delete(message.id);
    }
    send(owner.demo, { ...message, active: activeCount(owner.demo) });
  });
}

for (const event_name of Object.values(Workflow.event_names.step)) {
  Workflow.events.step.on(event_name, (detail) => {
    const owner = ownerOf(detail);
    if (!owner) return;
    send(owner.demo, { ...summarize('step', event_name, detail, owner), active: activeCount(owner.demo) });
  });
}

router.get('/server-status/stream', (req, res) => {
  const demo = String(req.query.demo ?? '');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Replay recent events first, then hello with the current active count.
  for (const frame of recent.get(demo) ?? []) res.write(frame);
  res.write(`event: hello\ndata: ${JSON.stringify({ demo, active: activeCount(demo), server_time: Date.now() })}\n\n`);

  const client = { res, demo };
  clients.add(client);
  const keep_alive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keep_alive);
    clients.delete(client);
  });
});
