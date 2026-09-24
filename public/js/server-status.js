// The second status window on backend demos: live micro-flow activity on the
// *server*, streamed from /api/server-status/stream (Server-Sent Events).
// The top-right Workflow Status panel keeps showing the page's own
// client-side workflow.
import { badgeFor } from './launch-feed.js';

const MAX_EVENTS = 12;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createServerStatus({ demo }) {
  const panel = el('aside', 'server-panel');
  panel.setAttribute('aria-label', 'Server status');

  const head = el('h2');
  const dot = el('span', 'server-dot');
  head.append(dot, 'Server Status');

  const badge = el('div', 'step-type-badge', '—');
  const step = el('span', 'stat-value', '—');
  const detail = el('span', 'stat-value', 'connecting…');
  const active = el('span', '', '0');

  const step_row = el('div', 'stat-row');
  step_row.append(el('span', 'stat-label', 'Server step'), step);
  const detail_row = el('div', 'stat-row');
  detail_row.append(el('span', 'stat-label', 'Event'), detail);

  const counter = el('div', 'counter');
  counter.append('Active server workflows: ', active);

  const events = el('ol', 'server-events');
  const source = el('div', 'server-source', `SSE · /api/server-status/stream?demo=${demo}`);

  panel.append(head, badge, step_row, detail_row, counter, events, source);
  document.body.append(panel);

  const listeners = new Set();
  let stream = null;

  function connect() {
    stream = new EventSource(`/api/server-status/stream?demo=${encodeURIComponent(demo)}`);
    stream.addEventListener('hello', onHello);
    stream.addEventListener('error', onError);
    stream.addEventListener('message', onMessage);
  }

  // Browsers allow only ~6 HTTP/1.1 connections per host across all tabs, and
  // each open stream holds one. Hidden tabs let theirs go.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stream?.close();
      stream = null;
      dot.className = 'server-dot';
      detail.textContent = 'paused while hidden';
    } else if (!stream) {
      connect();
    }
  });

  function onHello(e) {
    const hello = JSON.parse(e.data);
    dot.className = 'server-dot live';
    active.textContent = hello.active;
    detail.textContent = 'connected';
  }

  function onError() {
    dot.className = 'server-dot down';
    detail.textContent = 'reconnecting…';
  }

  function onMessage(e) {
    const m = JSON.parse(e.data);
    active.textContent = m.active;

    if (m.kind === 'step') {
      step.textContent = m.name;
      badge.textContent = badgeFor(m);
    } else {
      badge.textContent = `Workflow › ${m.status ?? m.event.replace('workflow_', '')}`;
      step.textContent = m.name;
    }
    detail.textContent = `${m.event}${m.ms != null ? ` · ${m.ms} ms` : ''}`;

    const item = el('li', `server-event ${/failed/.test(m.event) ? 'bad' : /complete/.test(m.event) ? 'good' : /retry/.test(m.event) ? 'warn' : ''}`);
    const time = new Date(m.at).toLocaleTimeString([], { hour12: false });
    item.append(
      el('span', 'server-event-time', time),
      el('span', 'server-event-name', m.event),
      el('span', 'server-event-subject', `${m.name}${m.job ? ` · ${m.job}` : ''}`),
    );
    events.prepend(item);
    while (events.children.length > MAX_EVENTS) events.lastChild.remove();

    for (const fn of listeners) fn(m);
  }

  connect();

  return {
    onEvent(fn) {
      listeners.add(fn);
    },
  };
}
