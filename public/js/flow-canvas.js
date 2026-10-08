// flow-canvas: an n8n-style editor. You draw a graph of nodes; Run compiles it
// into a tree of micro-flow Workflows (flow-compile.js) and executes it. All of
// the live run UI (node glow, wire packets, branch highlights, loop counters,
// the log and the status panel) is driven by micro-flow's events.
import { Workflow } from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { badgeFor } from './launch-feed.js';
import {
  NODE_TYPES, GROUPS, OPERATORS, outputsOf, portLabel, needsValue, describeCondition,
  StopError, sleep,
} from './flow-nodes.js';
import { compileGraph, validate, GraphError } from './flow-compile.js';
import { TEMPLATES } from './flow-templates.js';

const SVG = 'http://www.w3.org/2000/svg';
const GRAPH_KEY = 'flow-canvas:graph';
const SNAP = 10;
const MAX_JSON = 150_000;

const $ = (id) => document.getElementById(id);
const canvasEl = $('canvas');
const worldEl = $('world');
const wiresEl = $('wires');
const nodesEl = $('nodes');
const inspectorEl = $('inspector');
const quickEl = $('quick-add');
const errorEl = $('canvas-error');
const runBtn = $('run');
const pauseBtn = $('pause');
const stopBtn = $('stop');
const exitEl = $('exit-on-error');

const status = createStatusPanel();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- Graph state ---
let graph = { name: 'my-flow', nodes: [], edges: [], options: { exit_on_error: true } };
let selected = null;               // { kind: 'node' | 'edge', id }
const view = { x: 40, y: 60, zoom: 0.85 };
const node_els = new Map();        // node id → element
const wire_els = new Map();        // edge id → { group, path, hit }
const run_state = new Map();       // node id → { state, count, retries, ms, error, iterations }
const node_data = new Map();       // node id → { input, output }

const nodeById = (id) => graph.nodes.find((n) => n.id === id);
const edgeById = (id) => graph.edges.find((e) => e.id === id);
const uid = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 8)}`;

function uniqueName(base) {
  const names = new Set(graph.nodes.map((n) => n.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function createNode(type, x, y) {
  const def = NODE_TYPES[type];
  const node = {
    id: uid('n'),
    type,
    name: uniqueName(def.title),
    x: Math.round(x / SNAP) * SNAP,
    y: Math.round(y / SNAP) * SNAP,
    config: structuredClone(def.defaults),
    settings: { retries: 0, timeout_ms: '' },
  };
  graph.nodes.push(node);
  renderNode(node);
  return node;
}

function deleteNode(id) {
  graph.nodes = graph.nodes.filter((n) => n.id !== id);
  graph.edges = graph.edges.filter((e) => e.from !== id && e.to !== id);
  node_els.get(id)?.remove();
  node_els.delete(id);
  if (selected?.id === id) selected = null;
  changed();
}

function reaches(from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop();
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    graph.edges.filter((e) => e.from === id).forEach((e) => stack.push(e.to));
  }
  return false;
}

function addEdge(from, port, to) {
  if (from === to) return null;
  if (nodeById(to)?.type === 'trigger') return flashError('The trigger has no input: it always starts the flow.');
  if (graph.edges.some((e) => e.from === from && e.port === port && e.to === to)) return null;
  if (reaches(to, from)) return flashError('That wire would make a cycle. Use a Loop or Repeat node to run things more than once.');
  const edge = { id: uid('e'), from, port, to };
  graph.edges.push(edge);
  changed();
  return edge;
}

function deleteEdge(id) {
  graph.edges = graph.edges.filter((e) => e.id !== id);
  if (selected?.id === id) selected = null;
  changed();
}

// --- Rendering: nodes ---
function badgeText(id) {
  const s = run_state.get(id);
  if (!s) return '';
  const parts = [];
  if (s.iterations) parts.push(`⟳${s.iterations}`);
  if (s.count > 1) parts.push(`×${s.count}`);
  if (s.retries) parts.push(`retry ${s.retries}`);
  if (s.ms != null && s.state !== 'running') parts.push(`${s.ms} ms`);
  return parts.join(' · ');
}

function renderNode(node) {
  const def = NODE_TYPES[node.type];
  let nodeEl = node_els.get(node.id);
  if (!nodeEl) {
    nodeEl = el('div', 'node');
    nodeEl.dataset.id = node.id;
    nodesEl.append(nodeEl);
    node_els.set(node.id, nodeEl);
  }
  nodeEl.style.left = `${node.x}px`;
  nodeEl.style.top = `${node.y}px`;
  nodeEl.style.setProperty('--accent', def.color);
  nodeEl.classList.toggle('selected', selected?.kind === 'node' && selected.id === node.id);
  nodeEl.classList.toggle('is-trigger', node.type === 'trigger');
  const state = run_state.get(node.id)?.state;
  nodeEl.classList.remove('st-running', 'st-done', 'st-failed', 'st-skipped');
  if (state) nodeEl.classList.add(`st-${state}`);

  const head = el('div', 'node-head');
  head.append(el('span', 'node-icon', def.icon), el('span', 'node-name', node.name));
  const badge = el('span', 'node-badge', badgeText(node.id));
  badge.dataset.badge = '';
  const outs = el('div', 'outs');
  for (const port of outputsOf(node)) {
    const row = el('div', `out-row port-${port.split('-')[0]}`);
    row.dataset.port = port;
    const dot = el('span', 'port out');
    dot.dataset.port = port;
    row.append(el('span', 'out-label', portLabel(node, port)), dot);
    outs.append(row);
  }
  const children = [head, badge, el('div', 'node-summary', def.summary(node.config)), el('div', 'node-micro', def.micro), outs];
  if (def.inputs !== false) {
    const input = el('span', 'port in');
    input.dataset.port = 'in';
    children.push(input);
  }
  nodeEl.replaceChildren(...children);
}

function refreshBadge(id) {
  const badge = node_els.get(id)?.querySelector('[data-badge]');
  if (badge) badge.textContent = badgeText(id);
}

function setNodeState(id, patch) {
  const s = { count: 0, retries: 0, iterations: 0, ...run_state.get(id), ...patch };
  run_state.set(id, s);
  const nodeEl = node_els.get(id);
  if (!nodeEl) return;
  nodeEl.classList.remove('st-running', 'st-done', 'st-failed', 'st-skipped');
  if (s.state) nodeEl.classList.add(`st-${s.state}`);
  refreshBadge(id);
}

// --- Rendering: wires ---
function toWorld(clientX, clientY) {
  const r = worldEl.getBoundingClientRect();
  return { x: (clientX - r.left) / view.zoom, y: (clientY - r.top) / view.zoom };
}

function portPos(node_id, port) {
  const nodeEl = node_els.get(node_id);
  const dot = port === 'in'
    ? nodeEl?.querySelector('.port.in')
    : nodeEl?.querySelector(`.port.out[data-port="${CSS.escape(port)}"]`);
  if (!dot) return null;
  const r = dot.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function svg(tag, className) {
  const node = document.createElementNS(SVG, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

function renderWires() {
  for (const [id, w] of wire_els) {
    if (!edgeById(id)) {
      w.group.remove();
      wire_els.delete(id);
    }
  }
  for (const edge of graph.edges) {
    const a = portPos(edge.from, edge.port);
    const b = portPos(edge.to, 'in');
    let w = wire_els.get(edge.id);
    if (!w) {
      const group = svg('g', `wire-group port-${edge.port.split('-')[0]}`);
      const hit = svg('path', 'wire-hit');
      const path = svg('path', 'wire');
      hit.dataset.edge = edge.id;
      group.append(path, hit);
      wiresEl.append(group);
      w = { group, path, hit };
      wire_els.set(edge.id, w);
    }
    w.group.classList.toggle('selected', selected?.kind === 'edge' && selected.id === edge.id);
    if (!a || !b) continue;
    const d = curve(a, b);
    w.path.setAttribute('d', d);
    w.hit.setAttribute('d', d);
  }
}

// A packet travels along a wire when data flows through it.
function pulseEdge(edge_id) {
  const w = wire_els.get(edge_id);
  if (!w) return;
  w.group.classList.remove('flow');
  void w.group.getBBox();
  w.group.classList.add('flow');
  const dot = svg('circle', 'packet');
  dot.setAttribute('r', '5');
  const motion = svg('animateMotion');
  motion.setAttribute('dur', '420ms');
  motion.setAttribute('begin', 'indefinite');
  motion.setAttribute('fill', 'freeze');
  motion.setAttribute('path', w.path.getAttribute('d'));
  dot.append(motion);
  wiresEl.append(dot);
  motion.beginElement?.();
  setTimeout(() => dot.remove(), 520);
}

function markPort(node_id, port) {
  const row = node_els.get(node_id)?.querySelector(`.out-row[data-port="${CSS.escape(port)}"]`);
  if (row) {
    row.classList.remove('hot');
    void row.offsetWidth;
    row.classList.add('hot');
  }
  graph.edges.filter((e) => e.from === node_id && e.port === port).forEach((e) => pulseEdge(e.id));
}

function applyView() {
  worldEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  canvasEl.style.backgroundPosition = `${view.x}px ${view.y}px`;
  canvasEl.style.backgroundSize = `${20 * view.zoom}px ${20 * view.zoom}px`;
}

function renderAll() {
  nodesEl.replaceChildren();
  node_els.clear();
  wiresEl.replaceChildren();
  wire_els.clear();
  graph.nodes.forEach(renderNode);
  renderWires();
  renderInspector();
  $('hint').hidden = graph.nodes.length > 2;
}

function fitView() {
  if (!graph.nodes.length) return;
  const xs = graph.nodes.map((n) => n.x);
  const ys = graph.nodes.map((n) => n.y);
  const minX = Math.min(...xs) - 30;
  const minY = Math.min(...ys) - 30;
  const maxX = Math.max(...xs) + 240;
  const maxY = Math.max(...ys) + 170;
  const { width, height } = canvasEl.getBoundingClientRect();
  view.zoom = Math.max(0.35, Math.min(1, width / (maxX - minX), height / (maxY - minY)));
  view.x = (width - (maxX - minX) * view.zoom) / 2 - minX * view.zoom;
  view.y = (height - (maxY - minY) * view.zoom) / 2 - minY * view.zoom;
  applyView();
  renderWires();
}

// --- Save, load, share ---
let save_timer = null;

function changed({ inspector = true } = {}) {
  graph.nodes.forEach(renderNode);
  renderWires();
  if (inspector) renderInspector();
  $('hint').hidden = graph.nodes.length > 2;
  clearTimeout(save_timer);
  save_timer = setTimeout(() => {
    try { localStorage.setItem(GRAPH_KEY, JSON.stringify(graph)); } catch { /* storage unavailable */ }
    refreshPreview();
  }, 250);
}

function encode(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let text = '';
  bytes.forEach((b) => { text += String.fromCharCode(b); });
  return btoa(text);
}

function decode(text) {
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Keeps only nodes of known types and wires between them.
function sanitize(data) {
  if (!data || !Array.isArray(data.nodes)) return null;
  const nodes = data.nodes
    .filter((n) => n && NODE_TYPES[n.type] && typeof n.id === 'string')
    .map((n) => ({
      id: n.id,
      type: n.type,
      name: String(n.name ?? NODE_TYPES[n.type].title).slice(0, 60),
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      config: { ...structuredClone(NODE_TYPES[n.type].defaults), ...(n.config ?? {}) },
      settings: { retries: 0, timeout_ms: '', ...(n.settings ?? {}) },
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (data.edges ?? [])
    .filter((e) => e && ids.has(e.from) && ids.has(e.to) && typeof e.port === 'string')
    .map((e) => ({ id: String(e.id ?? uid('e')), from: e.from, port: e.port, to: e.to }));
  return {
    name: String(data.name ?? 'my-flow').slice(0, 60),
    nodes,
    edges,
    options: { exit_on_error: data.options?.exit_on_error !== false },
  };
}

function loadGraph(data) {
  const clean = sanitize(data);
  if (!clean) return false;
  graph = clean;
  selected = null;
  run_state.clear();
  node_data.clear();
  exitEl.checked = graph.options.exit_on_error;
  renderAll();
  requestAnimationFrame(fitView);
  changed();
  return true;
}

function readSaved() {
  const hash = new URLSearchParams(location.hash.slice(1)).get('g');
  if (hash) {
    try { return decode(hash); } catch (error) { console.error('Bad share link', error); }
  }
  try { return JSON.parse(localStorage.getItem(GRAPH_KEY)); } catch { return null; }
}

// --- Messages ---
let error_timer = null;

function flashError(message, node_id = null) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  clearTimeout(error_timer);
  error_timer = setTimeout(() => { errorEl.hidden = true; }, 4000);
  if (node_id) {
    const nodeEl = node_els.get(node_id);
    nodeEl?.classList.add('invalid');
    setTimeout(() => nodeEl?.classList.remove('invalid'), 1600);
  }
  return null;
}

// --- Palette and quick add ---
function renderPalette() {
  const palette = $('palette');
  for (const group of GROUPS) {
    palette.append(el('h3', 'palette-group', group));
    for (const [type, def] of Object.entries(NODE_TYPES).filter(([, d]) => d.group === group)) {
      const tile = el('button', 'tile');
      tile.type = 'button';
      tile.draggable = true;
      tile.dataset.type = type;
      tile.style.setProperty('--accent', def.color);
      tile.title = def.blurb;
      tile.append(el('span', 'tile-icon', def.icon), el('span', 'tile-name', def.title), el('span', 'tile-micro', def.micro));
      tile.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', type);
        e.dataTransfer.effectAllowed = 'copy';
      });
      // Clicking a tile (handy on touch screens) drops the node mid-canvas.
      tile.addEventListener('click', () => {
        const r = canvasEl.getBoundingClientRect();
        const p = toWorld(r.left + r.width / 2 - 90, r.top + r.height / 2 - 40);
        const node = addFromPalette(type, p.x + (Math.random() - 0.5) * 60, p.y + (Math.random() - 0.5) * 60);
        if (node) select({ kind: 'node', id: node.id });
      });
      palette.append(tile);
    }
  }
}

function addFromPalette(type, x, y) {
  if (type === 'trigger' && graph.nodes.some((n) => n.type === 'trigger')) {
    return flashError('There is already a Manual Trigger. A flow has exactly one.');
  }
  const node = createNode(type, x, y);
  changed();
  return node;
}

canvasEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

canvasEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const type = e.dataTransfer.getData('text/plain');
  if (!NODE_TYPES[type]) return;
  const p = toWorld(e.clientX, e.clientY);
  const node = addFromPalette(type, p.x - 90, p.y - 25);
  if (node) select({ kind: 'node', id: node.id });
});

let quick_pending = null; // { from, port, x, y } for a wire dropped on empty canvas

function openQuickAdd(clientX, clientY, pending) {
  quick_pending = { ...pending, ...toWorld(clientX, clientY) };
  const r = canvasEl.getBoundingClientRect();
  quickEl.replaceChildren(el('div', 'quick-title', pending.from ? 'Add and connect…' : 'Add node…'));
  const has_trigger = graph.nodes.some((n) => n.type === 'trigger');
  for (const [type, def] of Object.entries(NODE_TYPES)) {
    if (type === 'trigger' && (has_trigger || pending.from)) continue;
    const item = el('button', 'quick-item');
    item.type = 'button';
    item.style.setProperty('--accent', def.color);
    item.append(el('span', 'tile-icon', def.icon), el('span', '', def.title));
    item.addEventListener('click', () => {
      const node = createNode(type, quick_pending.x, quick_pending.y - 22);
      if (quick_pending.from) addEdge(quick_pending.from, quick_pending.port, node.id);
      closeQuickAdd();
      select({ kind: 'node', id: node.id });
      changed();
    });
    quickEl.append(item);
  }
  quickEl.hidden = false;
  const left = Math.min(clientX - r.left, r.width - 200);
  const top = Math.min(clientY - r.top, r.height - quickEl.offsetHeight - 8);
  quickEl.style.left = `${Math.max(4, left)}px`;
  quickEl.style.top = `${Math.max(4, top)}px`;
}

function closeQuickAdd() {
  quickEl.hidden = true;
  quick_pending = null;
}

// --- Pointer interactions: drag nodes, connect ports, pan, zoom ---
let gesture = null;

function select(next) {
  selected = next;
  graph.nodes.forEach((n) => node_els.get(n.id)?.classList.toggle('selected', next?.kind === 'node' && next.id === n.id));
  renderWires();
  renderInspector();
  renderNodeData();
}

canvasEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.quick-add')) return;
  closeQuickAdd();
  canvasEl.focus({ preventScroll: true });
  const port = e.target.closest('.port');
  const nodeEl = e.target.closest('.node');
  const hit = e.target.closest('.wire-hit');

  if (port?.classList.contains('out')) {
    gesture = { kind: 'connect', from: nodeEl.dataset.id, port: port.dataset.port, draft: svg('path', 'wire draft') };
    wiresEl.append(gesture.draft);
  } else if (port?.classList.contains('in')) {
    // Pulling a wire off an input picks it up again from its source.
    const edge = [...graph.edges].reverse().find((x) => x.to === nodeEl.dataset.id);
    if (!edge) return;
    deleteEdge(edge.id);
    gesture = { kind: 'connect', from: edge.from, port: edge.port, draft: svg('path', 'wire draft') };
    wiresEl.append(gesture.draft);
    moveDraft(e);
  } else if (hit) {
    select({ kind: 'edge', id: hit.dataset.edge });
    return;
  } else if (nodeEl) {
    const node = nodeById(nodeEl.dataset.id);
    gesture = { kind: 'node', node, start: { x: e.clientX, y: e.clientY }, origin: { x: node.x, y: node.y }, moved: false };
    nodeEl.classList.add('dragging');
  } else {
    gesture = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, origin: { x: view.x, y: view.y }, moved: false };
    canvasEl.classList.add('panning');
  }
  canvasEl.setPointerCapture(e.pointerId);
});

function moveDraft(e) {
  const a = portPos(gesture.from, gesture.port);
  const b = toWorld(e.clientX, e.clientY);
  if (a) gesture.draft.setAttribute('d', curve(a, b));
  document.querySelectorAll('.node.drop-target').forEach((n) => n.classList.remove('drop-target'));
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
  if (target && target.dataset.id !== gesture.from) target.classList.add('drop-target');
}

canvasEl.addEventListener('pointermove', (e) => {
  if (!gesture) return;
  if (gesture.kind === 'connect') {
    moveDraft(e);
  } else if (gesture.kind === 'node') {
    const dx = (e.clientX - gesture.start.x) / view.zoom;
    const dy = (e.clientY - gesture.start.y) / view.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 3) gesture.moved = true;
    gesture.node.x = Math.round((gesture.origin.x + dx) / SNAP) * SNAP;
    gesture.node.y = Math.round((gesture.origin.y + dy) / SNAP) * SNAP;
    const nodeEl = node_els.get(gesture.node.id);
    nodeEl.style.left = `${gesture.node.x}px`;
    nodeEl.style.top = `${gesture.node.y}px`;
    renderWires();
  } else if (gesture.kind === 'pan') {
    const dx = e.clientX - gesture.start.x;
    const dy = e.clientY - gesture.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) gesture.moved = true;
    view.x = gesture.origin.x + dx;
    view.y = gesture.origin.y + dy;
    applyView();
  }
});

canvasEl.addEventListener('pointerup', (e) => {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  canvasEl.classList.remove('panning');
  if (g.kind === 'connect') {
    g.draft.remove();
    document.querySelectorAll('.node.drop-target').forEach((n) => n.classList.remove('drop-target'));
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
    if (target && target.dataset.id !== g.from) {
      addEdge(g.from, g.port, target.dataset.id);
    } else if (!target) {
      openQuickAdd(e.clientX, e.clientY, { from: g.from, port: g.port });
    }
  } else if (g.kind === 'node') {
    node_els.get(g.node.id)?.classList.remove('dragging');
    if (g.moved) changed({ inspector: false });
    else select({ kind: 'node', id: g.node.id });
  } else if (g.kind === 'pan' && !g.moved) {
    select(null);
  }
});

canvasEl.addEventListener('pointercancel', () => {
  gesture?.draft?.remove();
  gesture = null;
  canvasEl.classList.remove('panning');
});

canvasEl.addEventListener('dblclick', (e) => {
  if (e.target.closest('.node, .quick-add')) return;
  openQuickAdd(e.clientX, e.clientY, {});
});

canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvasEl.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  const wx = (cx - view.x) / view.zoom;
  const wy = (cy - view.y) / view.zoom;
  view.zoom = Math.max(0.3, Math.min(1.6, view.zoom * Math.exp(-e.deltaY * 0.0015)));
  view.x = cx - wx * view.zoom;
  view.y = cy - wy * view.zoom;
  applyView();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run();
    return;
  }
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'Escape') {
    closeQuickAdd();
    select(null);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    e.preventDefault();
    if (selected.kind === 'node') deleteNode(selected.id);
    else deleteEdge(selected.id);
  }
});

// --- Inspector ---
function field(label, input, hint) {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'stat-label', label), input);
  if (hint) wrap.append(el('span', 'field-hint', hint));
  return wrap;
}

function textInput(value, onInput, { type = 'text', placeholder = '' } = {}) {
  const input = el('input', 'input');
  input.type = type;
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.addEventListener('input', () => onInput(input.value, input));
  return input;
}

function selectInput(options, value, onChange) {
  const input = el('select', 'input');
  input.replaceChildren(...options.map(([v, label]) => new Option(label, v)));
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

function renderCases(node) {
  const box = el('div', 'cases');
  (node.config.cases ?? []).forEach((kase, i) => {
    const row = el('div', 'case-row');
    row.append(
      el('span', 'case-n', `${i + 1}`),
      selectInput(OPERATORS, kase.op, (op) => { kase.op = op; changed(); }),
      textInput(kase.value, (v) => { kase.value = v; changed({ inspector: false }); }, { placeholder: needsValue(kase.op) ? 'value' : '—' }),
    );
    const remove = el('button', 'icon-button', '×');
    remove.type = 'button';
    remove.title = 'Remove case';
    remove.addEventListener('click', () => {
      node.config.cases.splice(i, 1);
      // Ports are numbered, so wires on later cases move up by one.
      graph.edges = graph.edges
        .filter((e) => !(e.from === node.id && e.port === `case-${i}`))
        .map((e) => {
          const m = e.from === node.id && e.port.match(/^case-(\d+)$/);
          return m && Number(m[1]) > i ? { ...e, port: `case-${Number(m[1]) - 1}` } : e;
        });
      wiresEl.replaceChildren();
      wire_els.clear();
      changed();
    });
    row.append(remove);
    box.append(row);
  });
  const add = el('button', 'button ghost small', '+ Case');
  add.type = 'button';
  add.addEventListener('click', () => {
    node.config.cases = [...(node.config.cases ?? []), { op: '===', value: '' }];
    changed();
  });
  box.append(add);
  return box;
}

function renderInspector() {
  inspectorEl.replaceChildren();
  if (selected?.kind === 'node' && nodeById(selected.id)) return renderNodeInspector(nodeById(selected.id));
  if (selected?.kind === 'edge' && edgeById(selected.id)) {
    const edge = edgeById(selected.id);
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    inspectorEl.append(
      el('h2', '', 'Wire'),
      el('p', 'blurb', `${from.name}${edge.port === 'main' ? '' : ` (${portLabel(from, edge.port)})`} → ${to.name}`),
    );
    const del = el('button', 'button ghost danger', 'Delete wire');
    del.type = 'button';
    del.addEventListener('click', () => deleteEdge(edge.id));
    inspectorEl.append(del);
    return;
  }

  inspectorEl.append(el('h2', '', 'Flow'));
  inspectorEl.append(field('Root workflow name', textInput(graph.name, (v) => {
    graph.name = v.trim() || 'my-flow';
    changed({ inspector: false });
  })));
  let problem = '';
  try { validate(graph); } catch (error) { problem = error.message; }
  inspectorEl.append(el('p', `blurb ${problem ? 'bad' : 'good'}`, problem || `Ready: ${graph.nodes.length} nodes, ${graph.edges.length} wires.`));
  const help = el('ul', 'help');
  [
    'Click a node to edit it. Delete / Backspace removes the selection.',
    'Drag from an output dot to a node to connect. Drop on empty space to add a node there.',
    'Drag a wire off an input dot to move or remove it.',
    'Double-click the canvas to add a node. Scroll to zoom.',
    'Ctrl / Cmd + Enter runs the flow.',
  ].forEach((t) => help.append(el('li', '', t)));
  inspectorEl.append(help);
}

function renderNodeInspector(node) {
  const def = NODE_TYPES[node.type];
  const head = el('div', 'inspector-head');
  head.style.setProperty('--accent', def.color);
  head.append(el('span', 'node-icon', def.icon), el('h2', '', def.title), el('span', 'step-type-badge', def.micro));
  inspectorEl.append(head, el('p', 'blurb', def.blurb));

  inspectorEl.append(field('Name (the micro-flow step name)', textInput(node.name, (v) => {
    node.name = v.trim().slice(0, 60) || def.title;
    changed({ inspector: false });
  })));

  for (const f of def.fields) {
    if (f.show && !f.show(node.config)) continue;
    const value = node.config[f.key];
    const set = (v) => { node.config[f.key] = v; changed({ inspector: false }); };
    if (f.kind === 'select') {
      inspectorEl.append(field(f.label, selectInput(f.options, value, (v) => { node.config[f.key] = v; changed(); })));
    } else if (f.kind === 'operator') {
      inspectorEl.append(field(f.label, selectInput(OPERATORS, value, (v) => { node.config[f.key] = v; changed(); })));
    } else if (f.kind === 'cases') {
      inspectorEl.append(field(f.label, renderCases(node)));
    } else if (f.kind === 'textarea' || f.kind === 'json') {
      const area = el('textarea', 'input area');
      area.value = value ?? '';
      area.spellcheck = false;
      area.rows = f.kind === 'json' ? 7 : 5;
      area.addEventListener('input', () => {
        if (f.kind === 'json') {
          try { JSON.parse(area.value); area.classList.remove('bad'); } catch { area.classList.add('bad'); }
        }
        set(area.value);
      });
      inspectorEl.append(field(f.label, area));
    } else {
      inspectorEl.append(field(f.label, textInput(value, (v) => set(f.kind === 'number' ? Number(v) : v), { type: f.kind === 'number' ? 'number' : 'text' })));
    }
  }

  if (def.kind !== 'delay') {
    const settings = el('details', 'settings');
    settings.open = Boolean(node.settings.retries || node.settings.timeout_ms);
    settings.append(el('summary', '', 'Settings'));
    const container = ['if', 'switch', 'loop', 'repeat'].includes(def.kind);
    settings.append(
      field('Retries (max_retries)', textInput(node.settings.retries, (v) => {
        node.settings.retries = Math.max(0, Math.min(10, Number(v) || 0));
        changed({ inspector: false });
      }, { type: 'number' })),
      field('Timeout ms (max_timeout_ms)', textInput(node.settings.timeout_ms, (v) => {
        node.settings.timeout_ms = v === '' ? '' : Math.max(1, Number(v) || 1);
        changed({ inspector: false });
      }, { type: 'number', placeholder: container ? 'none' : '30000' }), container ? 'Covers every branch it runs.' : ''),
    );
    inspectorEl.append(settings);
  }

  const s = run_state.get(node.id);
  if (s) {
    const last = el('div', `last-run st-${s.state}`);
    last.append(el('span', 'stat-label', 'Last run'), el('span', 'stat-value', `${s.state}${s.ms != null ? ` · ${s.ms} ms` : ''}${s.count ? ` · ran ${s.count}×` : ''}`));
    if (s.error) last.append(el('span', 'last-error', s.error));
    inspectorEl.append(last);
  }

  const del = el('button', 'button ghost danger', 'Delete node');
  del.type = 'button';
  del.addEventListener('click', () => deleteNode(node.id));
  inspectorEl.append(del);
}

// The inspector sits in the right column, just under the status panel.
const status_panel = $('status-panel');
function placeInspector() {
  inspectorEl.style.top = `${status_panel.getBoundingClientRect().bottom + 12}px`;
}
new ResizeObserver(placeInspector).observe(status_panel);
window.addEventListener('resize', () => { placeInspector(); renderWires(); });

// --- Drawer tabs ---
let active_tab = 'output';
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  active_tab = tab.dataset.tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== active_tab; });
  refreshPreview();
  renderNodeData();
});

function addCard({ title, image, text, tone }) {
  const cards = $('cards');
  cards.querySelector('.empty')?.remove();
  const card = el('div', `card tone-${tone || 'violet'}`);
  if (/^https?:\/\//.test(image)) {
    const img = el('img');
    img.src = image;
    img.alt = title;
    img.loading = 'lazy';
    card.append(img);
  }
  card.append(el('strong', '', title || '(no title)'));
  if (text) card.append(el('span', '', text));
  cards.append(card);
}

const MAX_LOG = 400;
function log(event, subject, tone = '') {
  const list = $('log');
  const now = new Date();
  const li = el('li', `log-entry ${tone}`);
  li.append(
    el('span', 'log-time', `${now.toLocaleTimeString([], { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`),
    el('span', 'log-event', event),
    el('span', 'log-subject', subject),
  );
  list.append(li);
  while (list.children.length > MAX_LOG) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}

function preview(value) {
  if (value === undefined) return 'undefined';
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length > 20000 ? `${text.slice(0, 20000)}\n… (${text.length.toLocaleString()} characters, truncated)` : text;
}

function renderNodeData() {
  if (active_tab !== 'data') return;
  const box = $('node-data');
  const node = selected?.kind === 'node' ? nodeById(selected.id) : null;
  const data = node && node_data.get(node.id);
  if (!data) {
    box.replaceChildren(el('p', 'empty', node ? `${node.name} has no data yet: run the flow.` : 'Select a node after a run to see its last input and output.'));
    return;
  }
  const col = (label, value) => {
    const c = el('div', 'data-col');
    c.append(el('span', 'stat-label', label), el('pre', 'json', preview(value)));
    return c;
  };
  box.replaceChildren(col(`${node.name} · input`, data.input), col(`${node.name} · output`, data.output));
}

// Badge for a live step instance (badgeFor takes the serialized form).
const liveBadge = (step) => badgeFor({
  class_name: step.constructor.step_name,
  loop_type: step.loop_type,
  delay_type: step.delay_type,
  flow_control_type: step.flow_control_type,
  callable_type: step.callable_type,
});

function treeOf(compiled, wf) {
  const list = el('ul', 'tree-list');
  for (const step of wf.steps) {
    const li = el('li', step.name.startsWith('·') ? 'hidden-step' : '');
    const row = el('div', 'tree-row');
    row.append(el('span', 'step-type-badge', liveBadge(step)), el('span', 'tree-name', step.name));
    const info = compiled.steps.get(step.id);
    if (info) {
      row.classList.add('linked');
      row.addEventListener('click', () => select({ kind: 'node', id: info.node_id }));
    }
    li.append(row);
    if (step.constructor.step_name === 'switch') {
      // children holds one body per case, in order, then the default body.
      const kids = compiled.children.get(step.id) ?? [];
      const cases = el('ul', 'tree-list');
      step.cases.forEach((kase, i) => {
        const { operator, value } = kase.conditional_config;
        const kli = el('li');
        const krow = el('div', 'tree-row');
        krow.append(el('span', 'step-type-badge', 'Case'), el('span', 'tree-name', `${kase.name} (${operator} ${typeof value === 'function' ? '{{…}}' : value ?? ''})`));
        kli.append(krow);
        if (kids[i]) kli.append(workflowRow(compiled, kids[i].workflow, 'callable'));
        cases.append(kli);
      });
      li.append(cases);
      if (kids.at(-1)) li.append(workflowRow(compiled, kids.at(-1).workflow, 'default_callable'));
    } else {
      for (const kid of compiled.children.get(step.id) ?? []) li.append(workflowRow(compiled, kid.workflow, kid.label));
    }
    list.append(li);
  }
  if (!wf.steps.length) list.append(el('li', 'tree-empty', '(no steps)'));
  return list;
}

function workflowRow(compiled, wf, label) {
  const box = el('div', 'tree-wf');
  const row = el('div', 'tree-row');
  row.append(el('span', 'step-type-badge wf', `Workflow`), el('span', 'tree-name', `${wf.name}`), el('span', 'tree-label', label));
  box.append(row, treeOf(compiled, wf));
  return box;
}

let current = null;   // the compiled run: { root, steps, bodies, children, workflows }
let ctx = null;
let running = false;

// The Compiled and serialize() tabs show the graph as micro-flow sees it.
// Outside a run they compile a throwaway copy.
function refreshPreview() {
  if (active_tab !== 'tree' && active_tab !== 'json') return;
  let compiled = current;
  if (!running) {
    try {
      compiled = compileGraph(graph, makeCtx(), { exit_on_error: graph.options.exit_on_error });
    } catch (error) {
      $('tree').replaceChildren(el('p', 'empty bad', error.message));
      $('json').textContent = error.message;
      return;
    }
  }
  if (active_tab === 'tree') {
    $('tree').replaceChildren(workflowRow(compiled, compiled.root, 'root'));
  } else {
    const text = JSON.stringify(compiled.root.prepareForSerialization(), null, 2);
    $('json').textContent = text.length > MAX_JSON ? `${text.slice(0, MAX_JSON)}\n… truncated` : text;
  }
}

// --- Running ---
function makeCtx() {
  const c = {
    out: new Map(),
    last: undefined,
    item: undefined,
    trigger: undefined,
    stopped: false,
    iteration_failed: false,
    display: (card) => addCard(card),
    record(node_id, input, output) {
      node_data.set(node_id, { input, output });
      if (selected?.id === node_id) renderNodeData();
    },
    async sleep(ms) {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        if (c.stopped) throw new StopError('stopped by user');
        await sleep(Math.min(50, end - performance.now()));
      }
    },
  };
  return c;
}

let run_count = 0;
let step_count = 0;
let paused = false;

function setButtons() {
  runBtn.disabled = running;
  pauseBtn.disabled = !running;
  stopBtn.disabled = !running;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
}

function describeStep(step, info) {
  const node = info && nodeById(info.node_id);
  if (step.class_name === 'delay') return `waiting ${step.relative_delay_ms} ms`;
  if (step.class_name === 'case') return `checking case ${step.conditional?.operator} ${step.conditional?.value ?? '{{…}}'}`;
  if (!node) return step.callable_type === 'workflow' ? `sub-workflow "${step.callable?.value?.name ?? ''}"` : 'running';
  const def = NODE_TYPES[node.type];
  if (['if', 'break', 'skip'].includes(def.kind)) return describeCondition(node.config.path, node.config.op, node.config.value);
  return def.summary(node.config);
}

const errorOf = (step_id) => {
  const live = current?.steps.get(step_id)?.step;
  const error = live?.errors?.at(-1);
  return error?.message ?? (error ? String(error) : '');
};

const ev = Workflow.events;
const isMine = (id) => running && current?.steps.has(id);

ev.step.on('step_running', (step) => {
  if (!running || !current) return;
  if (!step.name.startsWith('·')) {
    step_count += 1;
    $('step-count').textContent = step_count;
    const info = current.steps.get(step.id);
    status(step.name, describeStep(step, info), badgeFor(step));
  }
  const info = current.steps.get(step.id);
  if (!info) return;
  if (info.port) {
    markPort(info.node_id, info.port);
    return;
  }
  const prev = run_state.get(info.node_id);
  setNodeState(info.node_id, { state: 'running', count: (prev?.count ?? 0) + 1, retries: 0, error: '' });
  if (info.edge_id) pulseEdge(info.edge_id);
  log('step_running', step.name);
});

ev.step.on('step_complete', (step) => {
  if (!isMine(step.id)) return;
  const info = current.steps.get(step.id);
  if (info.port) return;
  setNodeState(info.node_id, { state: 'done', ms: step.timing?.execution_time_ms ?? null });
  log('step_complete', `${step.name} · ${step.timing?.execution_time_ms ?? '?'} ms`, 'good');
  if (selected?.id === info.node_id) renderInspector();
});

ev.step.on('step_failed', (step) => {
  if (!running || !ctx) return;
  ctx.iteration_failed = true;
  if (!isMine(step.id)) return;
  const info = current.steps.get(step.id);
  const message = errorOf(step.id) || 'failed';
  if (!info.port) setNodeState(info.node_id, { state: 'failed', ms: step.timing?.execution_time_ms ?? null, error: message });
  log('step_failed', `${step.name}: ${message}`, 'bad');
  if (selected?.id === info.node_id) renderInspector();
});

ev.step.on('step_retrying', (step) => {
  if (!isMine(step.id)) return;
  const info = current.steps.get(step.id);
  setNodeState(info.node_id, { retries: step.retry_count });
  status(step.name, `retry ${step.retry_count} of ${step.max_retries}`, badgeFor(step));
  log('step_retrying', `${step.name} · attempt ${step.retry_count + 1} of ${step.max_retries + 1}`, 'warn');
});

for (const [name, branch] of [['conditional_true_branch_executed', true], ['conditional_false_branch_executed', false]]) {
  ev.step.on(name, (step) => {
    if (!isMine(step.id)) return;
    const info = current.steps.get(step.id);
    const kind = NODE_TYPES[nodeById(info.node_id)?.type]?.kind;
    if (kind === 'if') {
      status(step.name, `condition ${branch} → ${branch} branch`, 'ConditionalStep');
      log(name, `${step.name} → ${branch}`);
    } else if (branch) {
      status(step.name, kind === 'break' ? 'condition true → break' : 'condition true → skip next', badgeFor(step));
      log(name, `${step.name}: ${kind === 'break' ? 'stopping this branch' : 'skipping the next step'}`, 'warn');
    }
  });
}

ev.step.on('switch_case_matched', (step) => {
  if (isMine(step.id)) log('switch_case_matched', step.name);
});

ev.workflow.on('workflow_running', (wf) => {
  if (!running || !current) return;
  const body = current.bodies.get(wf.id);
  if (!body) return;
  markPort(body.node_id, body.port);
  if (body.port === 'each') {
    const s = run_state.get(body.node_id);
    setNodeState(body.node_id, { iterations: (s?.iterations ?? 0) + 1 });
  }
});

ev.workflow.on('workflow_step_skipped', ({ step }) => {
  if (!isMine(step?.id)) return;
  const info = current.steps.get(step.id);
  setNodeState(info.node_id, { state: 'skipped' });
  log('workflow_step_skipped', step.name, 'warn');
});

ev.workflow.on('workflow_break_executed', ({ workflow }) => {
  if (running) log('workflow_break_executed', `rest of "${workflow?.name}" stopped`, 'warn');
});

ev.workflow.on('workflow_errored', ({ workflow, step }) => {
  if (running) log('workflow_errored', `"${workflow?.name}" continues after ${step?.name} failed`, 'warn');
});

// pause events carry the workflow's state ({ workflow }), not the workflow.
ev.workflow.on('workflow_paused', (payload) => {
  const wf = payload?.workflow ?? payload;
  if (!running || wf?.id !== current?.root.id) return;
  status(wf.name, 'paused between top-level steps', 'Workflow › paused');
  log('workflow_paused', wf.name, 'warn');
  pauseBtn.disabled = false;
});

// Nested bodies run many times, and each run adds to their `sessions`. Every
// snapshot of a body (loop results, event payloads) embeds them all, so they
// are cleared after each run. Only the root keeps its sessions.
const live_workflows = new Map();
for (const name of ['workflow_complete', 'workflow_failed']) {
  ev.workflow.on(name, (wf) => {
    if (!current || wf.id === current.root.id) return;
    const live = live_workflows.get(wf.id);
    if (live) live.sessions = {};
  });
}

async function drive(promise) {
  try {
    await promise;
  } catch (error) {
    console.error(error);
  }
  if (current.root.status === 'paused' && !ctx.stopped) return;
  finish();
}

function run() {
  if (running) return;
  closeQuickAdd();
  ctx = makeCtx();
  try {
    current = compileGraph(graph, ctx, { exit_on_error: graph.options.exit_on_error });
  } catch (error) {
    if (!(error instanceof GraphError)) console.error(error);
    flashError(error.message, error.node_id);
    return;
  }
  live_workflows.clear();
  current.workflows.forEach((wf) => live_workflows.set(wf.id, wf));
  run_state.clear();
  node_data.clear();
  graph.nodes.forEach(renderNode);
  $('cards').replaceChildren();
  $('log').replaceChildren();
  running = true;
  paused = false;
  run_count += 1;
  $('run-count').textContent = run_count;
  setButtons();
  canvasEl.classList.add('is-running');
  log('workflow_running', `${current.root.name} (run ${run_count})`);
  refreshPreview();
  drive(current.root.execute());
}

function finish() {
  const root = current.root;
  running = false;
  paused = false;
  setButtons();
  canvasEl.classList.remove('is-running');
  const sessions = Object.values(root.sessions ?? {});
  const ms = sessions.at(-1)?.timing?.execution_time_ms ?? root.timing?.execution_time_ms;
  const outcome = ctx.stopped ? 'stopped' : root.status;
  const failure = root.results?.at(-1)?.data?.error?.message;
  const detail = outcome === 'failed' && failure ? ` — ${failure}` : '';
  status(root.name, `${outcome}${ms != null ? ` in ${ms} ms` : ''}${detail}`, `Workflow › ${outcome}`);
  log(`workflow_${outcome}`, `${root.name}${ms != null ? ` · ${ms} ms` : ''} · ${sessions.length} session${sessions.length === 1 ? '' : 's'}${detail}`,
    outcome === 'complete' ? 'good' : 'bad');
  if (!$('cards').children.length) $('cards').append(el('p', 'empty', 'No Display node ran.'));
  // Nodes still marked running were cut short (stopped, or their branch broke).
  for (const [id, s] of run_state) if (s.state === 'running') setNodeState(id, { state: 'skipped' });
  refreshPreview();
  renderInspector();
  renderNodeData();
}

runBtn.addEventListener('click', run);

pauseBtn.addEventListener('click', () => {
  if (!running) return;
  const root = current.root;
  if (paused) {
    paused = false;
    setButtons();
    log('workflow_resumed', root.name);
    drive(root.resume());
  } else {
    paused = true;
    setButtons();
    pauseBtn.disabled = true; // re-enabled by workflow_paused
    root.pause();
    const step = root.steps.find((s) => s.id === root.current_step);
    status(root.name, `pause requested: takes effect after "${step?.name ?? 'the current step'}"`, 'Workflow › pause()');
    log('workflow_pause_requested', root.name, 'warn');
  }
});

stopBtn.addEventListener('click', () => {
  if (!running) return;
  ctx.stopped = true;
  log('stop', 'stopping: the next step throws', 'warn');
  if (current.root.status === 'paused') finish();
});

exitEl.addEventListener('change', () => {
  graph.options.exit_on_error = exitEl.checked;
  changed({ inspector: false });
});

// --- Toolbar ---
const templateEl = $('template');
templateEl.append(new Option('Load a template…', ''));
for (const [key, t] of Object.entries(TEMPLATES)) templateEl.append(new Option(t.title, key));
templateEl.addEventListener('change', () => {
  const t = TEMPLATES[templateEl.value];
  templateEl.value = '';
  if (!t || running) return;
  loadGraph(structuredClone(t));
  $('cards').replaceChildren(el('p', 'empty', `Loaded "${t.title}". Press Run.`));
});

$('fit').addEventListener('click', fitView);

$('clear').addEventListener('click', () => {
  if (running) return;
  loadGraph({ name: 'my-flow', nodes: [], edges: [], options: { exit_on_error: true } });
  const t = createNode('trigger', 80, 160);
  select({ kind: 'node', id: t.id });
  changed();
});

$('share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#g=${encode(graph)}`;
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    $('share').textContent = 'Copied';
  } catch {
    $('share').textContent = 'See URL';
  }
  setTimeout(() => { $('share').textContent = 'Share'; }, 1600);
});

// --- Start ---
renderPalette();
applyView();
if (!loadGraph(readSaved())) loadGraph(structuredClone(TEMPLATES.pokemon));
placeInspector();
setButtons();
