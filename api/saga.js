// order-saga: a distributed transaction across mock services (orders,
// inventory, payments, shipping, email) run as a micro-flow workflow on the
// server. Each forward step that succeeds pushes its compensation onto a
// stack; if a later step fails, a compensation workflow is built at runtime
// from that stack (in reverse) and undoes what was done. Stock, the payments
// ledger and shipments are shared by every visitor.
import express from 'express';
import crypto from 'crypto';
import { Workflow, Step } from '@ronaldroe/micro-flow';
import { track, forget } from './server-status.js';

export const router = express.Router();

const DEMO = 'saga';
const MAX_ORDERS = 30;
const MAX_RUNNING = 5;
const MAX_QTY = 5;
const SHIPMENT_TIMEOUT_MS = 2000;

const PRODUCTS = [
  { sku: 'gear', name: 'Brass gear set', price: 2400, capacity: 8 },
  { sku: 'lamp', name: 'Moth lamp', price: 3900, capacity: 5 },
  { sku: 'kite', name: 'Storm kite', price: 5800, capacity: 3 },
  { sku: 'mug', name: 'Cloud mug', price: 1600, capacity: 12 },
];
const BY_SKU = Object.fromEntries(PRODUCTS.map((p) => [p.sku, p]));

const CARDS = {
  '4242424242424242': { label: '··4242', behaviour: 'ok' },
  '4000000000000002': { label: '··0002', behaviour: 'declined' },
  '4000000000000119': { label: '··0119', behaviour: 'flaky' },
};

const REGIONS = {
  eu: { name: 'Europe', carrier: 'Rhine Freight' },
  na: { name: 'North America', carrier: 'Prairie Post' },
  aq: { name: 'Antarctica', carrier: null },
};

const FAULTS = ['slow_carrier', 'email_down', 'orders_db_down', 'inventory_down_on_undo'];

// --- Shared "services" state ---
const stock = Object.fromEntries(PRODUCTS.map((p) => [p.sku, p.capacity])); // on hand
const reservations = new Map(); // order id → { sku: qty }
const authorizations = new Map(); // order id → { amount, state }
const shipments = new Map(); // shipment id → { order_id, region, status }
const ledger = { authorized: 0, captured: 0, voided: 0, refunded: 0 };

const orders = new Map(); // id → order
let running = 0;

function reserved(sku) {
  let total = 0;
  for (const items of reservations.values()) total += items[sku] ?? 0;
  return total;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const latency = () => 250 + crypto.randomInt(450);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

// Every service call waits a little, then runs `work` and records the outcome
// on the order's timeline (in the order the calls finish).
async function call(order, service, action, kind, work, wait = latency()) {
  const started = Date.now();
  order.step = action;
  await sleep(wait);
  try {
    const detail = await work();
    order.timeline.push({ service, action, kind, ok: true, at: started, ms: Date.now() - started, detail: detail ?? '' });
    return detail;
  } catch (error) {
    order.timeline.push({ service, action, kind: 'error', ok: false, at: started, ms: Date.now() - started, detail: error.message });
    throw error;
  }
}

// --- Compensations (pushed by forward steps, run in reverse on failure) ---
const compensations = {
  cancelOrder: (order) => ({
    name: 'cancel-order',
    service: 'Orders',
    run: async () => 'order record marked cancelled',
  }),
  releaseInventory: (order) => ({
    name: 'release-inventory',
    service: 'Inventory',
    run: async () => {
      if (order.faults.inventory_down_on_undo) throw new Error('inventory service unavailable (503)');
      // Idempotent: releasing twice is a no-op.
      if (!reservations.delete(order.id)) return 'nothing to release';
      return `released ${describeItems(order.items)}`;
    },
  }),
  voidAuthorization: (order) => ({
    name: 'void-authorization',
    service: 'Payments',
    run: async () => {
      const auth = authorizations.get(order.id);
      if (!auth || auth.state !== 'authorized') return 'nothing to void';
      auth.state = 'voided';
      ledger.authorized -= auth.amount;
      ledger.voided += auth.amount;
      return `voided ${money(auth.amount)} hold`;
    },
  }),
  refundCapture: (order) => ({
    name: 'refund-capture',
    service: 'Payments',
    run: async () => {
      const auth = authorizations.get(order.id);
      if (!auth || auth.state !== 'captured') return 'nothing to refund';
      auth.state = 'refunded';
      ledger.captured -= auth.amount;
      ledger.refunded += auth.amount;
      return `refunded ${money(auth.amount)}`;
    },
  }),
  cancelShipment: (order) => ({
    name: 'cancel-shipment',
    service: 'Shipping',
    run: async () => {
      // Idempotent: cancels whatever is booked for this order, if anything.
      let cancelled = 0;
      for (const shipment of shipments.values()) {
        if (shipment.order_id === order.id && shipment.status === 'booked') {
          shipment.status = 'cancelled';
          cancelled++;
        }
      }
      return cancelled ? `cancelled shipment ${order.shipment_id}` : 'nothing to cancel';
    },
  }),
};

function describeItems(items) {
  return Object.entries(items).map(([sku, qty]) => `${qty}× ${BY_SKU[sku].name}`).join(', ');
}

// --- The forward saga ---
function buildSaga(order) {
  const push = (comp) => order.stack.push(comp);

  return new Workflow({
    name: `saga:${order.id}`,
    exit_on_error: true,
    steps: [
      new Step({
        name: 'create-order',
        callable: async () => {
          await call(order, 'Orders', 'create-order', 'forward', async () => `order ${order.id} pending · ${money(order.total)}`);
          push(compensations.cancelOrder(order));
        },
      }),

      new Step({
        name: 'reserve-inventory',
        callable: async () => {
          await call(order, 'Inventory', 'reserve-inventory', 'forward', async () => {
            // Check every line, then reserve all of them (no await in between).
            for (const [sku, qty] of Object.entries(order.items)) {
              const available = stock[sku] - reserved(sku);
              if (available < qty) throw new Error(`out of stock: ${BY_SKU[sku].name} (need ${qty}, ${Math.max(0, available)} left)`);
            }
            reservations.set(order.id, { ...order.items });
            return `reserved ${describeItems(order.items)}`;
          });
          push(compensations.releaseInventory(order));
        },
      }),

      // Retries cover transient gateway errors. A decline is permanent, so it
      // turns the remaining retries off before throwing.
      new Step({
        name: 'authorize-payment',
        max_retries: 2,
        callable: async function () {
          const attempt = this.retry_count + 1;
          if (attempt > 1) await sleep(200 * 2 ** (attempt - 1)); // backoff
          const card = CARDS[order.card];
          await call(order, 'Payments', 'authorize-payment', attempt > 1 ? 'retry' : 'forward', async () => {
            if (card.behaviour === 'declined') {
              this.max_retries = this.retry_count; // don't retry a decline
              throw new Error('card declined (do_not_honor)');
            }
            if (card.behaviour === 'flaky' && attempt <= 2) throw new Error(`gateway timeout (attempt ${attempt})`);
            authorizations.set(order.id, { amount: order.total, state: 'authorized' });
            ledger.authorized += order.total;
            return `authorized ${money(order.total)} on ${card.label}${attempt > 1 ? ` · attempt ${attempt}` : ''}`;
          });
          push(compensations.voidAuthorization(order));
        },
      }),

      // A timeout doesn't cancel the callable: a slow carrier still answers
      // later, so the late reply checks `aborted` and books nothing.
      new Step({
        name: 'book-shipment',
        max_timeout_ms: SHIPMENT_TIMEOUT_MS,
        callable: async () => {
          const region = REGIONS[order.region];
          const wait = order.faults.slow_carrier ? SHIPMENT_TIMEOUT_MS + 1200 : latency();
          await call(order, 'Shipping', 'book-shipment', 'forward', async () => {
            if (order.aborted) throw new Error('late carrier reply after the timeout, booking discarded');
            if (!region.carrier) throw new Error(`no carrier ships to ${region.name}`);
            order.shipment_id = `SH-${crypto.randomUUID().slice(0, 6)}`;
            shipments.set(order.shipment_id, { order_id: order.id, region: order.region, status: 'booked' });
            return `${region.carrier} · ${order.shipment_id} to ${region.name}`;
          }, wait);
          push(compensations.cancelShipment(order));
        },
      }),

      new Step({
        name: 'capture-payment',
        callable: async () => {
          await call(order, 'Payments', 'capture-payment', 'forward', async () => {
            const auth = authorizations.get(order.id);
            auth.state = 'captured';
            ledger.authorized -= auth.amount;
            ledger.captured += auth.amount;
            return `captured ${money(auth.amount)}`;
          });
          // A captured payment is undone with a refund, not a void.
          const index = order.stack.findIndex((c) => c.name === 'void-authorization');
          order.stack.splice(index, 1, compensations.refundCapture(order));
        },
      }),

      new Step({
        name: 'confirm-order',
        callable: async () => {
          await call(order, 'Orders', 'confirm-order', 'forward', async () => {
            if (order.faults.orders_db_down) throw new Error('orders database unavailable');
            // Commit the reservation: it leaves stock for good.
            for (const [sku, qty] of Object.entries(order.items)) stock[sku] -= qty;
            reservations.delete(order.id);
            order.status = 'confirmed';
            return 'order confirmed, stock committed';
          });
        },
      }),
    ],
  });
}

// Side effects after the commit point. A failure here doesn't undo the order,
// so this workflow doesn't exit on error and the step's failure is just a warning.
function buildAfterConfirm(order) {
  return new Workflow({
    name: `after-confirm:${order.id}`,
    steps: [
      new Step({
        name: 'send-receipt',
        max_retries: 1,
        callable: async function () {
          const attempt = this.retry_count + 1;
          await call(order, 'Email', 'send-receipt', attempt > 1 ? 'retry' : 'forward', async () => {
            if (order.faults.email_down) throw new Error('mail provider returned 503');
            return `receipt emailed for ${money(order.total)}`;
          });
        },
      }),
    ],
  });
}

function buildCompensation(order) {
  // Every compensation is attempted, even if an earlier one fails.
  const undo = new Workflow({ name: `compensate:${order.id}` });
  for (const comp of [...order.stack].reverse()) {
    undo.addStep(new Step({
      name: comp.name,
      max_retries: 2,
      callable: async function () {
        const attempt = this.retry_count + 1;
        if (attempt > 1) await sleep(200 * 2 ** (attempt - 1));
        await call(order, comp.service, comp.name, 'compensate', comp.run);
      },
    }));
  }
  return undo;
}

async function runSaga(order) {
  const saga = buildSaga(order);
  order.workflows.push(saga);
  track(saga, DEMO, order.id, { top: true });
  await saga.execute();

  if (saga.status !== 'failed') {
    const after = buildAfterConfirm(order);
    order.workflows.push(after);
    track(after, DEMO, order.id, { top: true });
    await after.execute();
    const receipt = after.steps[0];
    if (receipt.status === 'failed') order.warnings.push(`receipt not sent: ${receipt.errors.at(-1)?.message ?? 'failed'}`);
    return;
  }

  // Failed: stop any late replies, then undo in reverse.
  const failed = saga.steps.find((s) => s.status === 'failed');
  const message = failed?.errors.at(-1)?.message ?? 'failed';
  order.aborted = true;
  order.failed_step = failed?.name ?? null;
  if (/timed out/.test(message)) {
    order.timeline.push({ service: 'Shipping', action: failed.name, kind: 'error', ok: false, at: Date.now(), ms: SHIPMENT_TIMEOUT_MS, detail: `timed out after ${SHIPMENT_TIMEOUT_MS} ms` });
    order.reason = `${failed.name}: carrier timed out after ${SHIPMENT_TIMEOUT_MS} ms`;
  } else {
    order.reason = `${failed?.name ?? 'saga'}: ${message}`;
  }
  order.status = 'compensating';

  const undo = buildCompensation(order);
  order.workflows.push(undo);
  track(undo, DEMO, order.id, { top: true });
  await undo.execute();

  const stuck = undo.steps.filter((s) => s.status === 'failed');
  if (stuck.length) {
    order.status = 'needs-attention';
    order.warnings.push(`compensation failed: ${stuck.map((s) => s.name).join(', ')}. An operator has to fix this by hand.`);
  } else {
    order.status = 'cancelled';
  }
}

// --- API ---
function publicOrder(order) {
  const { workflows, stack, card, ...rest } = order;
  return {
    ...rest,
    card: CARDS[card].label,
    region_name: REGIONS[order.region].name,
    pending_compensations: stack.map((c) => c.name),
  };
}

function state() {
  const booked = [...shipments.values()].filter((s) => s.status === 'booked').length;
  return {
    server_time: Date.now(),
    running,
    inventory: PRODUCTS.map((p) => ({ ...p, stock: stock[p.sku], reserved: reserved(p.sku) })),
    ledger: { ...ledger, shipments_booked: booked, shipments_cancelled: shipments.size - booked },
    orders: [...orders.values()].reverse().map((o) => ({
      id: o.id,
      status: o.status,
      total: o.total,
      items: describeItems(o.items),
      reason: o.reason,
      warnings: o.warnings.length,
      created_at: o.created_at,
      finished_at: o.finished_at,
    })),
  };
}

router.get('/saga/state', (req, res) => res.json(state()));

router.get('/saga/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'No such order.' });
  res.json(publicOrder(order));
});

router.post('/saga/orders', (req, res) => {
  const { items: raw_items, card, region, faults: raw_faults } = req.body ?? {};

  const items = {};
  for (const [sku, qty] of Object.entries(raw_items ?? {})) {
    const n = Math.floor(Number(qty));
    if (!BY_SKU[sku]) return res.status(400).json({ error: `Unknown product "${sku}".` });
    if (!Number.isFinite(n) || n < 0 || n > MAX_QTY) return res.status(400).json({ error: `Quantity must be 0–${MAX_QTY}.` });
    if (n > 0) items[sku] = n;
  }
  if (!Object.keys(items).length) return res.status(400).json({ error: 'Add at least one item.' });
  if (!CARDS[card]) return res.status(400).json({ error: 'Pick one of the test cards.' });
  if (!REGIONS[region]) return res.status(400).json({ error: 'Pick a shipping region.' });
  if (running >= MAX_RUNNING) return res.status(429).json({ error: `${MAX_RUNNING} orders are already in flight. Try again in a few seconds.` });

  const faults = Object.fromEntries(FAULTS.map((f) => [f, Boolean(raw_faults?.[f])]));
  const order = {
    id: crypto.randomUUID().slice(0, 8),
    status: 'running',
    step: null,
    items,
    total: Object.entries(items).reduce((sum, [sku, qty]) => sum + BY_SKU[sku].price * qty, 0),
    card,
    region,
    faults,
    timeline: [],
    warnings: [],
    reason: null,
    failed_step: null,
    shipment_id: null,
    aborted: false,
    created_at: Date.now(),
    finished_at: null,
    stack: [],
    workflows: [],
  };
  orders.set(order.id, order);

  // Keep only the newest orders.
  for (const [id, old] of orders) {
    if (orders.size <= MAX_ORDERS) break;
    if (old.finished_at) {
      old.workflows.forEach(forget);
      orders.delete(id);
    }
  }

  running++;
  // Not awaited: the request returns now and the saga runs on the server.
  runSaga(order)
    .catch((error) => {
      order.status = 'needs-attention';
      order.warnings.push(`saga crashed: ${error.message}`);
    })
    .finally(() => {
      order.step = null;
      order.finished_at = Date.now();
      running--;
    });

  res.status(202).json({ id: order.id });
});

// Restock puts stock back to capacity and drops reservations left by orders
// that are no longer running (for example a failed release).
router.post('/saga/restock', (req, res) => {
  for (const p of PRODUCTS) stock[p.sku] = p.capacity;
  for (const id of reservations.keys()) {
    if (orders.get(id)?.finished_at || !orders.has(id)) reservations.delete(id);
  }
  res.json(state());
});
