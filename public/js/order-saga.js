import { Workflow, Step, LoopStep } from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { createServerStatus } from './server-status.js';
import { badgeFor } from './launch-feed.js';

const $ = (id) => document.getElementById(id);
const formEl = $('order-form');
const placeBtn = $('place');
const errorEl = $('form-error');

const status = createStatusPanel();
const server = createServerStatus({ demo: 'saga' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const MAX_QTY = 5;

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

// --- Services: products, inventory and ledger (shared by every visitor) ---
let state = null;
const cart = { gear: 1, mug: 1 };

function renderProducts() {
  const list = $('products');
  list.replaceChildren();
  for (const p of state.inventory) {
    const qty = cart[p.sku] ?? 0;
    const available = p.stock - p.reserved;
    const li = el('li', `product${qty ? ' picked' : ''}`);
    const info = el('div', 'product-info');
    info.append(
      el('div', 'product-name', p.name),
      el('div', `product-meta${available <= 0 ? ' out' : available <= 1 ? ' low' : ''}`,
        `${money(p.price)} · ${available <= 0 ? 'sold out' : `${available} available`}`),
    );

    const stepper = el('div', 'stepper');
    const minus = el('button', '', '−');
    const plus = el('button', '', '+');
    minus.type = plus.type = 'button';
    minus.setAttribute('aria-label', `One fewer ${p.name}`);
    plus.setAttribute('aria-label', `One more ${p.name}`);
    minus.disabled = qty <= 0;
    plus.disabled = qty >= MAX_QTY;
    minus.addEventListener('click', () => { cart[p.sku] = qty - 1; renderProducts(); });
    plus.addEventListener('click', () => { cart[p.sku] = qty + 1; renderProducts(); });
    stepper.append(minus, el('output', '', String(qty)), plus);

    li.append(info, stepper);
    list.append(li);
  }
  const total = state.inventory.reduce((sum, p) => sum + p.price * (cart[p.sku] ?? 0), 0);
  $('order-total').textContent = money(total);
}

function renderServices() {
  const stock = $('stock');
  stock.replaceChildren();
  for (const p of state.inventory) {
    const row = el('li', 'stock-row');
    const bar = el('span', 'stock-bar');
    const free = el('span', 'free');
    const held = el('span', 'held');
    free.style.width = `${(Math.max(0, p.stock - p.reserved) / p.capacity) * 100}%`;
    held.style.width = `${(Math.min(p.reserved, p.stock) / p.capacity) * 100}%`;
    bar.append(free, held);
    row.append(el('span', '', p.name), bar, el('span', 'stock-count', `${p.stock}/${p.capacity}`));
    row.title = `${p.stock} on hand, ${p.reserved} reserved`;
    stock.append(row);
  }

  const l = state.ledger;
  const rows = [
    ['Authorized (held)', money(l.authorized), l.authorized ? 'held' : ''],
    ['Captured', money(l.captured), 'good'],
    ['Voided', money(l.voided), ''],
    ['Refunded', money(l.refunded), ''],
    ['Shipments booked', String(l.shipments_booked), 'good'],
    ['Shipments cancelled', String(l.shipments_cancelled), ''],
  ];
  $('ledger').replaceChildren(...rows.flatMap(([label, value, cls]) => [el('dt', '', label), el('dd', cls, value)]));
}

function renderRecent() {
  const list = $('recent');
  if (!state.orders.length) {
    list.replaceChildren(el('li', 'empty', 'No orders yet.'));
    return;
  }
  list.replaceChildren(...state.orders.map((o) => {
    const li = el('li');
    const btn = el('button', o.id === selected_id ? 'selected' : '');
    btn.type = 'button';
    btn.append(
      el('span', 'recent-id', o.id),
      el('span', `tag ${o.status}`, o.status),
      el('span', 'recent-items', o.items),
      el('span', 'recent-total', money(o.total)),
    );
    btn.title = o.reason ?? o.items;
    btn.addEventListener('click', () => selectOrder(o.id));
    li.append(btn);
    return li;
  }));
}

let refreshing = null;
async function refreshState() {
  refreshing ??= (async () => {
    try {
      state = await api('GET', '/api/saga/state');
      renderProducts();
      renderServices();
      renderRecent();
    } catch {
      // Try again on the next tick.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// --- Saga timeline ---
const LANES = ['Orders', 'Inventory', 'Payments', 'Shipping', 'Email'];
const LANE_OF = {
  'create-order': 'Orders', 'confirm-order': 'Orders', 'cancel-order': 'Orders',
  'reserve-inventory': 'Inventory', 'release-inventory': 'Inventory',
  'authorize-payment': 'Payments', 'capture-payment': 'Payments', 'void-authorization': 'Payments', 'refund-capture': 'Payments',
  'book-shipment': 'Shipping', 'cancel-shipment': 'Shipping',
  'send-receipt': 'Email',
};

let selected_id = null;
let viewed = null; // the order shown in the timeline

function renderTimeline(order) {
  viewed = order;
  const timeline = $('timeline');
  const pending = !order.finished_at && order.step ? 1 : 0;
  const columns = order.timeline.length + pending;
  timeline.style.gridTemplateColumns = `repeat(${Math.max(1, columns)}, 8rem)`;
  timeline.replaceChildren();

  LANES.forEach((lane, row) => {
    const track = el('div', 'lane-track');
    track.style.gridRow = row + 1;
    timeline.append(track);
  });

  order.timeline.forEach((entry, i) => {
    const chip = el('div', `chip ${entry.kind}`);
    chip.style.gridRow = LANES.indexOf(entry.service) + 1;
    chip.style.gridColumn = i + 1;
    chip.append(el('span', 'chip-action', entry.action), el('span', 'chip-detail', entry.detail));
    chip.title = `${entry.service} · ${entry.action} · ${entry.ms} ms\n${entry.detail}`;
    timeline.append(chip);
  });

  if (pending) {
    const chip = el('div', 'chip pending');
    chip.style.gridRow = LANES.indexOf(LANE_OF[order.step] ?? 'Orders') + 1;
    chip.style.gridColumn = columns;
    chip.append(el('span', 'chip-action', order.step), el('span', 'chip-detail', 'waiting for service…'));
    timeline.append(chip);
  }

  // Keep the newest action in view.
  const scroller = timeline.parentElement;
  scroller.scrollLeft = scroller.scrollWidth;

  $('timeline-note').textContent = `order ${order.id} · ${order.region_name} · card ${order.card}`;
  renderOutcome(order);
}

function renderOutcome(order) {
  const box = $('outcome');
  box.className = `outcome ${order.status}`;
  box.replaceChildren();
  const undone = order.timeline.filter((t) => t.kind === 'compensate').length;
  const headline = {
    running: `step ${order.step ?? '…'}`,
    compensating: `${order.reason}. Undoing what already ran…`,
    confirmed: `${money(order.total)} charged · shipment ${order.shipment_id} to ${order.region_name}.`,
    cancelled: `${order.reason}. ${undone ? `${undone} compensation${undone === 1 ? '' : 's'} undid every step that had run.` : 'Nothing had to be undone.'}`,
    'needs-attention': `${order.reason}. A compensation failed, so the order is only partly undone.`,
  }[order.status] ?? order.status;
  box.append(el('b', '', order.status.replace('-', ' ')), headline);
  for (const warning of order.warnings) box.append(el('span', 'warning', `⚠ ${warning}`));
  box.hidden = false;
}

async function selectOrder(id) {
  selected_id = id;
  try {
    renderTimeline(await api('GET', `/api/saga/orders/${id}`));
  } catch (error) {
    $('timeline-note').textContent = error.message;
  }
  if (state) renderRecent();
}

// --- Client-side workflow: build, POST, poll, show ---
let draft = null;
let order = null;
let placed = 0;

const client = new Workflow({
  name: 'place-order-client',
  exit_on_error: true,
  steps: [
    new Step({
      name: 'build-order',
      callable: async () => {
        const items = Object.fromEntries(Object.entries(cart).filter(([, qty]) => qty > 0));
        if (!Object.keys(items).length) throw new Error('Add at least one item.');
        const faults = Object.fromEntries([...formEl.querySelectorAll('.faults input')].map((input) => [input.name, input.checked]));
        draft = { items, card: $('card').value, region: $('region').value, faults };
        const on = Object.keys(faults).filter((f) => faults[f]);
        note(`${Object.values(items).reduce((a, b) => a + b, 0)} items${on.length ? ` · faults: ${on.join(', ')}` : ''}`);
      },
    }),
    new Step({
      name: 'post-order',
      callable: async () => {
        const { id } = await api('POST', '/api/saga/orders', draft);
        order = null;
        selected_id = id;
        note(`POST /api/saga/orders → 202 order ${id}`);
      },
    }),
    new LoopStep({
      name: 'poll-order',
      loop_type: 'while',
      conditional: { subject: () => (order?.finished_at ? 'finished' : 'open'), operator: '===', value: 'open' },
      max_iterations: 300,
      max_timeout_ms: 90 * 1000,
      callable: async function () {
        order = await api('GET', `/api/saga/orders/${selected_id}`);
        renderTimeline(order);
        refreshState();
        note(`poll ${this.results.length + 1}: ${order.status}${order.step ? ` · ${order.step}` : ''}`);
        if (!order.finished_at) await sleep(350);
      },
    }),
    new Step({
      name: 'show-outcome',
      callable: async () => {
        await refreshState();
        const undone = order.timeline.filter((t) => t.kind === 'compensate').length;
        note(order.status === 'confirmed'
          ? `confirmed${order.warnings.length ? ` with ${order.warnings.length} warning` : ''}`
          : `${order.status} · ${undone} compensations ran`);
      },
    }),
  ],
});

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  placeBtn.disabled = true;
  errorEl.hidden = true;
  try {
    await client.execute();
    if (client.status === 'failed') {
      const error = client.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message ?? 'failed';
      errorEl.textContent = error;
      errorEl.hidden = false;
      status(client.name, `failed — ${error}`, 'Workflow › failed');
    } else {
      placed += 1;
      $('placed-count').textContent = placed;
      status(client.name, `complete — order ${order.id} ${order.status}`, 'Workflow › complete');
    }
  } finally {
    placeBtn.disabled = false;
  }
});

$('restock').addEventListener('click', async () => {
  state = await api('POST', '/api/saga/restock');
  renderProducts();
  renderServices();
  renderRecent();
});

// Keep the shared services fresh, and follow an order someone else is viewing
// (or one opened from the Recent list) until it finishes.
let pending_refresh = null;
server.onEvent((m) => {
  if (m.kind !== 'workflow') return;
  clearTimeout(pending_refresh);
  pending_refresh = setTimeout(refreshState, 150);
});
setInterval(() => {
  refreshState();
  if (client.status !== 'running' && selected_id && viewed && !viewed.finished_at) selectOrder(selected_id);
}, 2000);

await refreshState();
if (state?.orders.length) selectOrder(state.orders[0].id);
