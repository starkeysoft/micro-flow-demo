// diner-rush: a kitchen where every ticket is a micro-flow Workflow and they
// all run concurrently. Some steps are "human" steps that wait for a click;
// their window is the step's max_timeout_ms and the last chance is a retry.
//
// shift (root Workflow)
//   open kitchen ............ Step: starts the closing-time Workflow
//                              (an absolute DelayStep until the doors close)
//   seat customers .......... LoopStep › generator: yields a ticket every few
//                              seconds and starts its Workflow without waiting
//   last orders ............. Step: waits for every open ticket
//   tally ................... Step: reads every ticket's sessions
//
// ticket #N (one Workflow per order, result_per_step_function → progress bar)
//   take order .............. Step (a reservation pauses its own Workflow here)
//   cook items .............. LoopStep › for_each, max_timeout_ms = patience
//     item body ............. Workflow [ SwitchStep on the dish → Case → recipe Workflow ]
//   (extra shake) ........... Step inserted live with addStepAtIndex()
//   quality check ........... ConditionalStep: all perfect → tip
//   offer dessert? .......... FlowControlStep › skip unless the customer is happy
//   sell pie ................ Step
//   serve ................... Step
import {
  Workflow,
  Step,
  LoopStep,
  ConditionalStep,
  SwitchStep,
  Case,
  DelayStep,
  FlowControlStep,
} from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { badgeFor } from './launch-feed.js';

const DISHES = {
  burger: { emoji: '🍔', price: 8, station: 'grill' },
  fries:  { emoji: '🍟', price: 4, station: 'fryer' },
  shake:  { emoji: '🥤', price: 5, station: 'shake' },
};
const PIE_PRICE = 3;
const WALKOUT_PENALTY = 5;
const CANCEL_PENALTY = 2;
const JAM_CHANCE = 0.3;
const MAX_FEED = 120;

const $ = (id) => document.getElementById(id);
const status = createStatusPanel();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- Feed ---
function feed(text, tone = '') {
  const list = $('feed');
  const li = el('li', `feed-entry ${tone}`);
  const left = Math.max(0, close_at - Date.now());
  li.append(el('span', 'feed-time', clockText(left)), el('span', 'feed-text', text));
  list.prepend(li);
  while (list.children.length > MAX_FEED) list.lastChild.remove();
}

const clockText = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// --- Stations ---
// A station has a few slots. acquire() waits (FIFO) for a free one.
class Station {
  constructor(key, title, capacity, verb) {
    this.key = key;
    this.title = title;
    this.capacity = capacity;
    this.verb = verb;
    this.reset();
  }

  reset() {
    this.slots = Array(this.capacity).fill(null);
    this.queue = [];
    this.kicked = false;
  }

  acquire(item) {
    return new Promise((resolve, reject) => {
      const free = this.slots.indexOf(null);
      if (free !== -1) {
        this.slots[free] = item;
        resolve(free);
      } else {
        this.queue.push({ item, resolve, reject });
      }
      renderStation(this);
    });
  }

  release(item) {
    const index = this.slots.indexOf(item);
    if (index !== -1) {
      this.slots[index] = null;
      const next = this.queue.shift();
      if (next) {
        this.slots[index] = next.item;
        next.resolve(index);
      }
    }
    renderStation(this);
  }

  // A cancelled or walked-out ticket leaves the queue and frees its slot.
  drop(item) {
    const waiting = this.queue.findIndex((q) => q.item === item);
    if (waiting !== -1) this.queue.splice(waiting, 1)[0].reject(new Error('ticket closed'));
    this.release(item);
  }
}

const stations = {
  grill: new Station('grill', 'Grill', 2, 'Plate it'),
  fryer: new Station('fryer', 'Fryer', 2, 'Basket up'),
  shake: new Station('shake', 'Shake machine', 1, 'Kick it'),
};

function renderStation(station) {
  let box = $(`station-${station.key}`);
  if (!box) {
    box = el('div', `station station-${station.key}`);
    box.id = `station-${station.key}`;
    $('stations').append(box);
  }
  const head = el('div', 'station-head');
  head.append(el('h2', '', station.title), el('span', 'station-queue', station.queue.length ? `${station.queue.length} waiting` : ''));
  const slots = el('div', 'slots');
  station.slots.forEach((item) => slots.append(renderSlot(station, item)));
  box.replaceChildren(head, slots);
}

function renderSlot(station, item) {
  const slot = el('div', 'slot');
  if (!item) {
    slot.classList.add('empty-slot');
    slot.append(el('span', 'slot-empty', 'free'));
    return slot;
  }
  slot.classList.add(`slot-${item.state}`);
  slot.append(el('span', 'slot-dish', DISHES[item.dish].emoji), el('span', 'slot-ticket', `#${item.order.n}`), el('span', 'slot-state', STATE_TEXT[item.state] ?? item.state));
  if (item.cook) {
    const bar = el('span', 'slot-bar cook');
    bar.style.setProperty('--ms', `${item.cook.ms}ms`);
    bar.style.animationDelay = `${item.cook.start - performance.now()}ms`;
    slot.append(bar);
  }
  if (item.task) {
    const button = el('button', 'button slot-action', item.task.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      const task = item.task;
      item.task = null;
      task.resolve();
    });
    const bar = el('span', 'slot-bar countdown');
    bar.style.setProperty('--ms', `${item.task.ms}ms`);
    bar.style.animationDelay = `${item.task.start - performance.now()}ms`;
    slot.append(button, bar);
  }
  return slot;
}

const STATE_TEXT = {
  waiting: 'waiting', queued: 'queued', cooking: 'cooking', ready: 'ready!', charring: 'charring!',
  blending: 'blending', jammed: 'JAMMED', done: 'done', ruined: 'ruined',
};

// --- Human steps ---
// Resolves when the player clicks. micro-flow's max_timeout_ms on the step
// decides how long they have; when it fires, step_retrying or step_failed
// clears the button (see the event listeners below).
function humanTask(item, label, ms) {
  return new Promise((resolve, reject) => {
    item.task = { label, ms, start: performance.now(), resolve, reject };
    renderStation(stations[DISHES[item.dish].station]);
  });
}

// --- Game state ---
let orders = [];
let order_count = 0;
let shift_open = false;
let shift_ms = 150_000;
let close_at = Date.now() + shift_ms;
let cash = 0;
let tally = { served: 0, angry: 0, cancelled: 0 };
let step_count = 0;
let shift = null;

const step_meta = new Map();      // step id → { order, role, station? }
const workflows = new Map();      // nested workflow id → workflow (sessions cleanup)

class TicketClosed extends Error {}

function alive(order) {
  if (order.closed) throw new TicketClosed(`ticket #${order.n} is closed`);
}

function setItem(item, state, extra = {}) {
  Object.assign(item, { state, cook: null }, extra);
  renderStation(stations[DISHES[item.dish].station]);
  renderTicket(item.order);
}

function track(step, order, role, extra = {}) {
  step_meta.set(step.id, { order, role, step, ...extra });
  return step;
}

function nested(workflow) {
  workflows.set(workflow.id, workflow);
  return workflow;
}

// --- Recipes (one Workflow per dish per ticket) ---
// current() returns the item being cooked: the loop's current_item, or the
// extra item for a shake added mid-order.
function recipe(order, dish, current) {
  const n = order.n;
  const station = stations[DISHES[dish].station];

  const waitFor = track(new Step({
    name: `#${n} wait for ${station.title.toLowerCase()}`,
    max_timeout_ms: null,
    callable: async function waitForStation() {
      const item = current();
      alive(order);
      setItem(item, 'queued');
      await station.acquire(item);
      alive(order);
    },
  }), order, 'queue');

  if (dish === 'shake') {
    const blend = track(new Step({
      name: `#${n} blend shake`,
      max_retries: 3,
      max_timeout_ms: 15000,
      callable: async function blendShake() {
        const item = current();
        alive(order);
        setItem(item, 'blending', { cook: { start: performance.now(), ms: 2200 } });
        await sleep(2200);
        alive(order);
        if (!station.kicked && Math.random() < JAM_CHANCE) {
          // Jammed: wait for a kick (or 5 s), then fail this attempt so
          // micro-flow retries it.
          setItem(item, 'jammed');
          // A kick clears the jam for the retry; otherwise it may jam again.
          station.kicked = await Promise.race([
            humanTask(item, 'Kick it', 5000).then(() => true),
            sleep(5000).then(() => false),
          ]);
          item.task = null;
          throw new Error('shake machine jammed');
        }
        station.kicked = false;
        item.quality = 'perfect';
        setItem(item, 'done');
        station.release(item);
      },
    }), order, 'blend');
    return nested(new Workflow({ name: `#${n} shake`, exit_on_error: true, steps: [waitFor, blend] }));
  }

  const cook_ms = dish === 'burger' ? 4000 : 5000;
  const cook = track(new DelayStep({
    name: `#${n} ${dish === 'burger' ? 'grill patty' : 'fry'}`,
    relative_delay_ms: cook_ms,
  }), order, 'cook', { current });

  const window_ms = dish === 'burger' ? 4500 : 5000;
  const finish = track(new Step({
    name: `#${n} ${dish === 'burger' ? 'plate burger' : 'lift fries'}`,
    max_timeout_ms: window_ms,
    max_retries: 1,
    callable: async function finishDish() {
      const item = current();
      alive(order);
      // The first attempt is the perfect window; the retry is the last chance.
      const late = this.retry_count > 0;
      setItem(item, late ? 'charring' : 'ready');
      await humanTask(item, late ? 'Save it!' : station.verb, window_ms);
      alive(order);
      item.quality = late ? (dish === 'burger' ? 'charred' : 'soggy') : 'perfect';
      setItem(item, 'done');
      station.release(item);
    },
  }), order, 'finish');

  return nested(new Workflow({ name: `#${n} ${dish}`, exit_on_error: true, steps: [waitFor, cook, finish] }));
}

// --- Tickets ---
const moodOf = (order) => {
  if (!order.cook_start) return 'happy';
  return (Date.now() - order.cook_start) / order.patience_ms < 0.6 ? 'happy' : 'impatient';
};

const orderValue = (order) => order.items.reduce((sum, item) => sum + DISHES[item.dish].price, 0);

function makeOrder() {
  order_count += 1;
  const size = pick([1, 1, 2, 2, 2, 3, 3]);
  const items = Array.from({ length: size }, () => pick(['burger', 'burger', 'fries', 'fries', 'shake']));
  const order = {
    n: order_count,
    items: [],
    reservation: order_count > 2 && Math.random() < 0.18,
    patience_ms: 16000 + size * 13000,
    cook_start: null,
    closed: false,
    outcome: null,
    paid: 0,
    tip: 0,
    pie: false,
    progress: 0,
    workflow: null,
  };
  order.items = items.map((dish, i) => ({ id: `${order.n}-${i}`, dish, order, state: 'waiting', quality: null, task: null, cook: null }));

  const n = order.n;
  let loop = null;
  const item_body = nested(new Workflow({
    name: `#${n} item`,
    exit_on_error: true,
    steps: [track(new SwitchStep({
      name: `#${n} route dish`,
      max_timeout_ms: null,
      subject: () => loop.current_item.dish,
      cases: Object.keys(DISHES).map((dish) => new Case({
        name: `#${n} ${dish} station`,
        max_timeout_ms: null,
        conditional: { subject: null, operator: '===', value: dish },
        callable: recipe(order, dish, () => loop.current_item),
      })),
    }), order, 'route')],
  }));

  loop = track(new LoopStep({
    name: `#${n} cook items`,
    loop_type: 'for_each',
    iterable: function ticketItems() {
      return order.items.filter((item) => !item.extra);
    },
    callable: item_body,
    max_timeout_ms: order.patience_ms,
  }), order, 'loop');

  const steps = [
    track(new Step({
      name: `#${n} take order`,
      callable: async function takeOrder() {
        await sleep(900);
        alive(order);
        // A reservation pauses its own ticket: pause() takes effect once
        // this step finishes, and Seat resumes from the next step.
        if (order.reservation && !order.seated) order.workflow.pause();
      },
    }), order, 'take'),
    loop,
    track(new ConditionalStep({
      name: `#${n} quality check`,
      max_timeout_ms: null,
      conditional: {
        subject: () => order.items.every((item) => item.quality === 'perfect'),
        operator: '===',
        value: true,
      },
      true_callable: function addTip() { order.tip = Math.ceil(orderValue(order) * 0.3); },
      false_callable: function noTip() { order.tip = 0; },
    }), order, 'quality'),
    track(new FlowControlStep({
      name: `#${n} offer dessert?`,
      flow_control_type: 'skip',
      conditional: { subject: () => moodOf(order), operator: '!==', value: 'happy' },
    }), order, 'dessert'),
    track(new Step({
      name: `#${n} sell pie`,
      callable: async function sellPie() {
        await sleep(400);
        order.pie = true;
      },
    }), order, 'pie'),
    track(new Step({
      name: `#${n} serve`,
      callable: async function serve() {
        await sleep(500);
        alive(order);
      },
    }), order, 'serve'),
  ];

  order.workflow = new Workflow({
    name: `ticket #${n}`,
    exit_on_error: true,
    steps,
    result_per_step: true,
    // Called with the ticket's serialized snapshot after every step.
    result_per_step_function: function ticketProgress(snapshot) {
      const done = snapshot.steps.filter((s) => s.status === 'complete').length;
      order.progress = done / snapshot.steps.length;
      renderTicket(order);
    },
  });
  return order;
}

// "Can I add a shake?" — inserts a step into a ticket whose Workflow is
// already running. execute() reads the step list live, so it runs right
// after the cooking loop.
function addShake(order) {
  const item = { id: `${order.n}-x`, dish: 'shake', order, state: 'waiting', quality: null, task: null, cook: null, extra: true };
  order.items.push(item);
  const wf = order.workflow;
  const step = track(new Step({
    name: `#${order.n} extra shake`,
    callable: recipe(order, 'shake', () => item),
    max_timeout_ms: 40000,
  }), order, 'extra');
  const at = wf.steps.findIndex((s) => s.id === wf.current_step);
  wf.addStepAtIndex(step, at + 1);
  feed(`#${order.n}: "Can I add a shake?" → addStepAtIndex(${at + 1}) on the running ticket`, 'warn');
  renderTicket(order);
}

// Ends a ticket: frees its stations and stops any pending human step.
function closeOrder(order, outcome) {
  if (order.outcome) return;
  order.closed = true;
  order.outcome = outcome;
  for (const item of order.items) {
    item.task?.reject?.(new TicketClosed('ticket closed'));
    item.task = null;
    stations[DISHES[item.dish].station].drop(item);
    if (item.state !== 'done') item.state = 'ruined';
  }
  if (outcome === 'served') {
    order.paid = orderValue(order) + order.tip + (order.pie ? PIE_PRICE : 0);
    cash += order.paid;
    tally.served += 1;
    feed(`#${order.n} served: $${order.paid}${order.tip ? ` (incl. $${order.tip} tip)` : ''}${order.pie ? ' + pie' : ''}`, 'good');
  } else if (outcome === 'walked out') {
    order.paid = -WALKOUT_PENALTY;
    cash -= WALKOUT_PENALTY;
    tally.angry += 1;
    feed(`#${order.n} walked out (-$${WALKOUT_PENALTY})`, 'bad');
  } else {
    order.paid = -CANCEL_PENALTY;
    cash -= CANCEL_PENALTY;
    tally.cancelled += 1;
    feed(`#${order.n} 86'd (-$${CANCEL_PENALTY})`, 'warn');
  }
  renderHud();
  renderTicket(order);
  setTimeout(() => {
    order.ticketEl?.classList.add('leaving');
    setTimeout(() => order.ticketEl?.remove(), 600);
  }, 2600);
}

async function drive(order, promise) {
  try {
    await promise;
  } catch (error) {
    console.error(error);
  }
  const wf = order.workflow;
  if (wf.status === 'paused' && !order.closed) {
    renderTicket(order);
    return;
  }
  if (order.outcome) return;
  if (wf.status === 'complete') closeOrder(order, 'served');
  else closeOrder(order, order.cancel_requested ? 'cancelled' : 'walked out');
  order.done?.();
}

function startOrder(order) {
  orders.push(order);
  order.finished = new Promise((resolve) => { order.done = resolve; });
  renderTicket(order);
  const list = order.items.map((i) => DISHES[i.dish].emoji).join(' ');
  feed(`#${order.n} walks in: ${list}${order.reservation ? ' (reservation, table not ready)' : ''}`);
  renderHud();
  drive(order, order.workflow.execute());
}

// --- Ticket UI ---
function renderTicket(order) {
  if (!order.ticketEl) {
    order.ticketEl = el('div', 'ticket');
    $('rail').querySelector('.empty')?.remove();
    $('rail').append(order.ticketEl);
  }
  const t = order.ticketEl;
  const wf_status = order.workflow?.status;
  t.className = `ticket ${order.outcome ? `out-${order.outcome.replace(' ', '-')}` : ''} ${wf_status === 'paused' ? 'is-paused' : ''}`;

  const head = el('div', 'ticket-head');
  head.append(el('strong', '', `#${order.n}`));
  if (order.reservation) head.append(el('span', 'tag', 'reservation'));
  head.append(el('span', 'ticket-status', order.outcome ?? (wf_status === 'paused' ? 'paused' : moodOf(order))));

  const items = el('div', 'ticket-items');
  for (const item of order.items) {
    const chip = el('span', `chip chip-${item.state}`, `${DISHES[item.dish].emoji} ${item.quality && item.quality !== 'perfect' ? item.quality : STATE_TEXT[item.state]}`);
    if (item.extra) chip.classList.add('extra');
    items.append(chip);
  }

  const patience = el('div', 'bar patience');
  if (order.cook_start && !order.outcome) {
    const fill = el('span', 'bar-fill');
    fill.style.setProperty('--ms', `${order.patience_ms}ms`);
    fill.style.animationDelay = `${order.cook_start - Date.now()}ms`;
    patience.append(fill);
  } else {
    patience.classList.add('idle');
  }
  const progress = el('div', 'bar progress');
  const pfill = el('span', 'bar-fill');
  pfill.style.width = `${Math.round(order.progress * 100)}%`;
  progress.append(pfill);

  const actions = el('div', 'ticket-actions');
  if (!order.outcome) {
    if (wf_status === 'paused') {
      const seat = el('button', 'button small', 'Seat them');
      seat.type = 'button';
      seat.addEventListener('click', () => {
        order.seated = true;
        feed(`#${order.n} seated → resume()`);
        drive(order, order.workflow.resume());
      });
      actions.append(seat);
    }
    const cancel = el('button', 'button ghost small', "86 it");
    cancel.type = 'button';
    cancel.title = 'Cancel this ticket';
    cancel.addEventListener('click', () => cancelOrder(order));
    actions.append(cancel);
  } else {
    actions.append(el('span', 'paid', order.paid >= 0 ? `+$${order.paid}` : `-$${-order.paid}`));
  }

  t.replaceChildren(head, items, el('span', 'stat-label', 'patience'), patience, el('span', 'stat-label', 'workflow progress'), progress, actions);
}

function cancelOrder(order) {
  if (order.outcome) return;
  order.cancel_requested = true;
  if (order.workflow.status === 'paused') {
    // A paused ticket isn't running anything, so it can close right away.
    closeOrder(order, 'cancelled');
    order.done?.();
    return;
  }
  // Whatever the ticket is waiting on throws, and exit_on_error fails the Workflow.
  order.closed = true;
  for (const item of order.items) {
    item.task?.reject?.(new TicketClosed('ticket cancelled'));
    item.task = null;
    stations[DISHES[item.dish].station].drop(item);
  }
}

function renderHud() {
  $('cash').textContent = cash < 0 ? `-$${-cash}` : `$${cash}`;
  $('served').textContent = tally.served;
  $('angry').textContent = tally.angry;
  $('cancelled').textContent = tally.cancelled;
  $('active-count').textContent = orders.filter((o) => !o.outcome).length;
}

// --- Events → UI ---
const ev = Workflow.events;

ev.step.on('step_running', (step) => {
  const meta = step_meta.get(step.id);
  if (!meta) return;
  step_count += 1;
  $('step-count').textContent = step_count;
  const { order, role, current } = meta;
  let text = 'running';
  if (role === 'loop') {
    order.cook_start = Date.now();
    renderTicket(order);
    text = `cooking ${order.items.length} items · patience ${Math.round(order.patience_ms / 1000)} s`;
  } else if (role === 'cook') {
    setItem(current(), 'cooking', { cook: { start: performance.now(), ms: step.relative_delay_ms } });
    text = `${step.relative_delay_ms} ms`;
  } else if (role === 'route') {
    text = 'switch on the dish';
  } else if (role === 'quality') {
    text = 'every item perfect?';
  } else if (role === 'dessert') {
    text = `customer is ${moodOf(order)}`;
  } else if (role === 'extra') {
    text = 'sub-workflow added mid-run';
  }
  status(step.name, text, badgeFor(step));
});

ev.step.on('step_retrying', (step) => {
  const meta = step_meta.get(step.id);
  if (!meta) return;
  const { order, role } = meta;
  for (const item of order.items) {
    if (item.task) {
      item.task = null;
      renderStation(stations[DISHES[item.dish].station]);
    }
  }
  if (role === 'blend') {
    feed(`#${order.n} shake machine jammed → step_retrying (${step.retry_count}/${step.max_retries})`, 'warn');
    status(step.name, `jammed, retry ${step.retry_count} of ${step.max_retries}`, badgeFor(step));
  } else {
    feed(`#${order.n} missed it! timed out after ${step.max_timeout_ms} ms → step_retrying: last chance`, 'warn');
    status(step.name, `timed out → retry ${step.retry_count}`, badgeFor(step));
  }
});

ev.step.on('step_failed', (step) => {
  const meta = step_meta.get(step.id);
  if (!meta) return;
  const { order, role } = meta;
  if (order.closed && role !== 'loop') return;
  for (const item of order.items) {
    if (item.task) {
      item.task = null;
      renderStation(stations[DISHES[item.dish].station]);
    }
  }
  // Payload errors don't survive JSON, so read the live step's last error.
  const message = meta.step.errors.at(-1)?.message ?? '';
  let reason = role === 'blend' ? 'shake machine gave up' : 'food ruined';
  if (role === 'loop') {
    reason = message.includes('timed out')
      ? `ran out of patience (max_timeout_ms ${Math.round(order.patience_ms / 1000)} s)`
      : 'a dish failed, so the loop failed too';
  }
  if (!order.cancel_requested && role !== 'route') feed(`#${order.n} step_failed: ${step.name}, ${reason}`, 'bad');
  status(step.name, `failed: ${reason}`, badgeFor(step));
});

for (const [name, tip] of [['conditional_true_branch_executed', true], ['conditional_false_branch_executed', false]]) {
  ev.step.on(name, (step) => {
    const meta = step_meta.get(step.id);
    if (meta?.role !== 'quality') return;
    feed(`#${meta.order.n} quality check: ${tip ? 'all perfect → tip' : 'not perfect, no tip'}`, tip ? 'good' : '');
  });
}

ev.workflow.on('workflow_step_skipped', ({ step }) => {
  const meta = step_meta.get(step?.id);
  if (meta) feed(`#${meta.order.n} impatient: FlowControlStep skipped "${step.name}"`);
});

ev.workflow.on('workflow_paused', (payload) => {
  const wf = payload?.workflow ?? payload;
  const order = orders.find((o) => o.workflow.id === wf?.id);
  if (!order) return;
  feed(`#${order.n} paused: waiting for a table`, 'warn');
  status(wf.name, 'paused: seat them to resume()', 'Workflow › paused');
  renderTicket(order);
});

ev.step.on('delay_step_absolute_scheduled', (step) => {
  if (step.name === 'doors close') feed(`absolute DelayStep scheduled: doors close at ${new Date(step.absolute_timestamp).toLocaleTimeString()}`);
});

// Nested workflows (item bodies, recipes) run again for every item; their
// sessions are cleared after each run so snapshots stay small.
for (const name of ['workflow_complete', 'workflow_failed']) {
  ev.workflow.on(name, (wf) => {
    const live = workflows.get(wf.id);
    if (live) live.sessions = {};
  });
}

// --- The shift ---
function buildShift() {
  const closing = new Workflow({
    name: 'closing time',
    steps: [
      new DelayStep({ name: 'doors close', delay_type: 'absolute', absolute_timestamp: new Date(close_at) }),
      new Step({
        name: 'close doors',
        callable: function closeDoors() {
          shift_open = false;
          feed('Doors closed: no more customers. Finish the open tickets!', 'warn');
          // Reservations still waiting for a table give up.
          for (const order of orders.filter((o) => !o.outcome && o.workflow.status === 'paused')) {
            closeOrder(order, 'walked out');
            order.done?.();
          }
        },
      }),
    ],
  });

  return new Workflow({
    name: 'shift',
    exit_on_error: true,
    steps: [
      new Step({
        name: 'open kitchen',
        callable: function openKitchen() {
          shift_open = true;
          // Runs alongside the rest of the shift.
          closing.execute();
        },
      }),
      new LoopStep({
        name: 'seat customers',
        loop_type: 'generator',
        max_iterations: 200,
        max_timeout_ms: null,
        // Each yield is one customer; the gap shrinks as the shift goes on.
        callable: async function* seatCustomers() {
          let last_extra = Date.now();
          while (shift_open) {
            const order = makeOrder();
            startOrder(order);
            yield { ticket: order.n, items: order.items.map((i) => i.dish) };
            const elapsed = 1 - (close_at - Date.now()) / shift_ms;
            await sleep(rand(6500, 9000) - elapsed * 3500);
            // Now and then someone adds a shake to a ticket that's cooking.
            if (Date.now() - last_extra > 18000) {
              const cooking = orders.filter((o) => !o.outcome && o.workflow.current_step === o.workflow.steps[1].id && !o.items.some((i) => i.extra));
              if (cooking.length) {
                addShake(pick(cooking));
                last_extra = Date.now();
              }
            }
          }
        },
      }),
      new Step({
        name: 'last orders',
        max_timeout_ms: null,
        callable: async function lastOrders() {
          await Promise.all(orders.map((o) => o.finished));
        },
      }),
      new Step({
        name: 'tally',
        callable: function tallyShift() {
          showSummary();
        },
      }),
    ],
  });
}

function showSummary() {
  const rows = $('summary-rows');
  rows.replaceChildren();
  for (const order of orders) {
    const session = Object.values(order.workflow.sessions ?? {}).at(-1);
    const tr = el('tr', `row-${(order.outcome ?? '').replace(' ', '-')}`);
    const ms = session?.timing?.execution_time_ms;
    tr.append(
      el('td', '', `#${order.n}`),
      el('td', '', order.items.map((i) => DISHES[i.dish].emoji).join(' ')),
      el('td', '', session?.status ?? order.workflow.status),
      el('td', '', ms != null ? `${(ms / 1000).toFixed(1)} s` : '—'),
      el('td', '', order.paid >= 0 ? `$${order.paid}` : `-$${-order.paid}`),
    );
    rows.append(tr);
  }
  $('summary-total').textContent = `${tally.served} served · ${tally.angry} walked out · ${tally.cancelled} 86'd · ${cash < 0 ? '-' : ''}$${Math.abs(cash)} in the till`;
  $('summary').showModal();
}

let clock_timer = null;

async function startShift() {
  $('start').disabled = true;
  $('length').disabled = true;
  shift_ms = Number($('length').value) * 1000;
  orders.forEach((o) => o.ticketEl?.remove());
  orders = [];
  order_count = 0;
  cash = 0;
  tally = { served: 0, angry: 0, cancelled: 0 };
  step_meta.clear();
  workflows.clear();
  Object.values(stations).forEach((s) => { s.reset(); renderStation(s); });
  $('feed').replaceChildren();
  $('rail').replaceChildren();
  close_at = Date.now() + shift_ms;
  renderHud();
  clearInterval(clock_timer);
  clock_timer = setInterval(() => {
    $('clock').textContent = clockText(Math.max(0, close_at - Date.now()));
    renderHud();
    // Mood changes over time; refresh the labels of tickets that are cooking.
    orders.filter((o) => o.cook_start && !o.outcome).forEach((o) => {
      const label = o.ticketEl?.querySelector('.ticket-status');
      if (label && o.workflow.status !== 'paused') label.textContent = moodOf(o);
    });
  }, 250);

  shift = buildShift();
  status('shift', 'opening the kitchen', 'Workflow › running');
  try {
    await shift.execute();
  } catch (error) {
    console.error(error);
  }
  clearInterval(clock_timer);
  $('clock').textContent = '0:00';
  status('shift', `${shift.status}: ${tally.served} served`, `Workflow › ${shift.status}`);
  $('start').disabled = false;
  $('length').disabled = false;
  $('start').textContent = 'New shift';
}

$('start').addEventListener('click', startShift);
$('length').addEventListener('change', () => {
  $('clock').textContent = clockText(Number($('length').value) * 1000);
});
Object.values(stations).forEach(renderStation);
renderHud();
