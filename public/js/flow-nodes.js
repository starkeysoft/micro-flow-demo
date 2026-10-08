// flow-canvas node catalogue: what each node looks like in the editor, the
// settings it has, and (for action nodes) what it does when its Step runs.
// flow-compile.js turns a graph of these nodes into a micro-flow Workflow tree.

export class StopError extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Paths and templates ---
// A path like `types[0].type.name` reads from the node's input. Two roots
// read from elsewhere: `$item` (the current item of the innermost loop) and
// `$trigger` (the trigger's output). `$` or an empty path is the input itself.
export function getPath(input, path, ctx = {}) {
  let text = String(path ?? '').trim();
  let base = input;
  if (text.startsWith('$item')) { base = ctx.item; text = text.slice(5); }
  else if (text.startsWith('$trigger')) { base = ctx.trigger; text = text.slice(8); }
  else if (text.startsWith('$')) text = text.slice(1);
  const parts = text.split(/[.[\]'"]/).filter(Boolean);
  let value = base;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

function setPath(target, path, value) {
  const parts = String(path).split(/[.[\]'"]/).filter(Boolean);
  let current = target;
  parts.slice(0, -1).forEach((part, i) => {
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    current = current[part];
  });
  current[parts.at(-1)] = value;
}

const WHOLE = /^\{\{\s*([^}]*?)\s*\}\}$/;

// '{{ a.b }}' on its own returns the raw value (a number stays a number);
// mixed text returns a string. Text with no {{ }} is auto-typed.
export function resolve(template, input, ctx) {
  const text = String(template ?? '');
  const whole = text.trim().match(WHOLE);
  if (whole) return getPath(input, whole[1], ctx);
  if (!text.includes('{{')) return autoType(text);
  return text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, path) => {
    const value = getPath(input, path, ctx);
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

export function autoType(text) {
  const t = String(text).trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  return text;
}

const asObject = (input) =>
  input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : { value: input };

// --- Conditions ---
// Every micro-flow comparator except custom_function (which would need code).
export const OPERATORS = [
  ['===', 'is (===)'], ['!==', 'is not (!==)'], ['==', '== (loose)'], ['!=', '!= (loose)'],
  ['>', '>'], ['>=', '>='], ['<', '<'], ['<=', '<='],
  ['string_contains', 'text contains'], ['string_not_contains', 'text does not contain'],
  ['string_starts_with', 'starts with'], ['string_ends_with', 'ends with'],
  ['array_contains', 'list contains'], ['array_not_contains', 'list does not contain'],
  ['in', 'is one of (a, b, c)'], ['not_in', 'is none of (a, b, c)'],
  ['regex_match', 'matches regex'], ['regex_not_match', 'does not match regex'],
  ['empty', 'is empty'], ['not_empty', 'is not empty'],
  ['nullish', 'is null / missing'], ['not_nullish', 'exists'],
  ['is_type', 'is type'], ['is_not_type', 'is not type'],
];

const NO_VALUE = new Set(['empty', 'not_empty', 'nullish', 'not_nullish']);
const TEXT_VALUE = new Set([
  'string_contains', 'string_not_contains', 'string_starts_with', 'string_ends_with',
  'regex_match', 'regex_not_match', 'is_type', 'is_not_type',
]);

export const needsValue = (op) => !NO_VALUE.has(op);

// The value side of a condition. A value with {{ }} becomes a function, which
// micro-flow calls each time it checks the condition.
export function conditionValue(op, raw, inputFn, ctx) {
  if (NO_VALUE.has(op)) return null;
  const text = String(raw ?? '');
  if (text.includes('{{')) return () => resolve(text, inputFn(), ctx);
  if (op === 'in' || op === 'not_in') return text.split(',').map((s) => autoType(s.trim()));
  if (TEXT_VALUE.has(op)) return text;
  return autoType(text);
}

export const opLabel = (op) => OPERATORS.find(([v]) => v === op)?.[1] ?? op;

export function describeCondition(path, op, value) {
  return `${path || '$'} ${opLabel(op)}${needsValue(op) ? ` ${value}` : ''}`;
}

// --- Node types ---
// kind: how flow-compile builds it. outputs: output port names (a function
// for Switch, whose ports follow its cases). run: an action node's work.
const TRANSFORM_OPS = [
  ['get', 'get value at path'], ['pluck', 'pluck field from each item'], ['length', 'count items'],
  ['first', 'first N items'], ['sum', 'sum (of field)'], ['sort', 'sort by field'],
  ['random', 'random item'], ['shuffle', 'shuffle'], ['keys', 'object keys'],
  ['match', 'regex match (first group)'],
];

function transform(input, c, ctx) {
  const source = c.path ? getPath(input, c.path, ctx) : input;
  const field = (item) => (c.field ? getPath(item, c.field) : item);
  switch (c.op) {
    case 'get': return source;
    case 'pluck': return list(source).map(field);
    case 'length': return list(source).length;
    case 'first': return list(source).slice(0, Number(c.n) || 0);
    case 'sum': return list(source).reduce((total, item) => total + (Number(field(item)) || 0), 0);
    case 'sort': return [...list(source)].sort((a, b) => (field(a) > field(b) ? 1 : field(a) < field(b) ? -1 : 0));
    case 'random': { const items = list(source); return items[Math.floor(Math.random() * items.length)]; }
    case 'shuffle': return [...list(source)].sort(() => Math.random() - 0.5);
    case 'keys': return Object.keys(source ?? {});
    case 'match': {
      const match = String(source ?? '').match(new RegExp(c.field));
      return match ? (match[1] ?? match[0]) : null;
    }
    default: return source;
  }
}

const TONES = [['violet', 'violet'], ['red', 'red'], ['blue', 'blue'], ['green', 'green'], ['amber', 'amber'], ['slate', 'slate']];

function list(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return value === undefined ? [] : [value];
}

function parseAssignments(text) {
  return String(text ?? '').split('\n')
    .map((line) => line.match(/^\s*([^=]+?)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value]);
}

export const NODE_TYPES = {
  trigger: {
    title: 'Manual Trigger', group: 'Trigger', icon: '▶', kind: 'action', color: '#22c55e',
    micro: 'Workflow + Step', outputs: ['main'], inputs: false,
    blurb: 'Starts the flow. Its output is the JSON below. The whole graph compiles into one root Workflow.',
    defaults: { json: '{}' },
    fields: [{ key: 'json', label: 'Output JSON', kind: 'json' }],
    summary: (c) => (c.json?.length > 32 ? `${c.json.slice(0, 32)}…` : c.json),
    run(input, c, ctx) {
      ctx.trigger = JSON.parse(c.json || '{}');
      return ctx.trigger;
    },
  },

  http: {
    title: 'HTTP Request', group: 'Data', icon: '⇄', kind: 'action', color: '#38bdf8',
    micro: 'Step', outputs: ['main'],
    blurb: 'GETs a URL from your browser and outputs the JSON response. The API must allow CORS. Use {{ path }} to build the URL from the input.',
    defaults: { url: 'https://pokeapi.co/api/v2/pokemon/{{id}}' },
    fields: [{ key: 'url', label: 'URL', kind: 'text' }],
    summary: (c) => c.url.replace(/^https?:\/\//, ''),
    async run(input, c, ctx) {
      const url = String(resolve(c.url, input, ctx));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res.json();
    },
  },

  set: {
    title: 'Edit Fields', group: 'Data', icon: '✎', kind: 'action', color: '#a78bfa',
    micro: 'Step', outputs: ['main'],
    blurb: 'Sets fields, one "key = value" per line. Values can use {{ path }}, {{ $item.x }} or {{ $trigger.x }}. "Keep only these" drops every other field.',
    defaults: { assignments: 'greeting = hello {{name}}', mode: 'merge' },
    fields: [
      { key: 'assignments', label: 'Fields (key = value)', kind: 'textarea' },
      { key: 'mode', label: 'Mode', kind: 'select', options: [['merge', 'merge into input'], ['replace', 'keep only these']] },
    ],
    summary: (c) => parseAssignments(c.assignments).map(([k]) => k).join(', ') || 'no fields',
    run(input, c, ctx) {
      const out = c.mode === 'replace' ? {} : asObject(input);
      for (const [key, value] of parseAssignments(c.assignments)) setPath(out, key, resolve(value, input, ctx));
      return out;
    },
  },

  transform: {
    title: 'Transform', group: 'Data', icon: 'ƒ', kind: 'action', color: '#c084fc',
    micro: 'Step', outputs: ['main'],
    blurb: 'Reshapes data: read a path, pluck a field from a list, count, sum, sort, shuffle, pick a random item or regex-match text. The result replaces the input, or is written into one field of it.',
    defaults: { op: 'get', path: '', field: '', n: 3, into: '' },
    fields: [
      { key: 'op', label: 'Operation', kind: 'select', options: TRANSFORM_OPS },
      { key: 'path', label: 'Source path (blank = input)', kind: 'text' },
      { key: 'field', label: 'Field', kind: 'text', show: (c) => ['pluck', 'sum', 'sort'].includes(c.op) },
      { key: 'field', label: 'Regex', kind: 'text', show: (c) => c.op === 'match' },
      { key: 'n', label: 'N', kind: 'number', show: (c) => c.op === 'first' },
      { key: 'into', label: 'Write into field (blank = replace input)', kind: 'text' },
    ],
    summary: (c) => `${TRANSFORM_OPS.find(([v]) => v === c.op)?.[1]}${c.path ? ` of ${c.path}` : ''}${c.into ? ` → ${c.into}` : ''}`,
    run(input, c, ctx) {
      const result = transform(input, c, ctx);
      if (!c.into) return result;
      const out = asObject(input);
      setPath(out, c.into, result);
      return out;
    },
  },

  random: {
    title: 'Random Number', group: 'Data', icon: '⚄', kind: 'action', color: '#f472b6',
    micro: 'Step', outputs: ['main'],
    blurb: 'Adds a random whole number between min and max (inclusive) to the input.',
    defaults: { field: 'id', min: 1, max: 1025 },
    fields: [
      { key: 'field', label: 'Field', kind: 'text' },
      { key: 'min', label: 'Min', kind: 'number' },
      { key: 'max', label: 'Max', kind: 'number' },
    ],
    summary: (c) => `${c.field} = ${c.min}…${c.max}`,
    run(input, c) {
      const min = Math.ceil(Number(c.min));
      const max = Math.floor(Number(c.max));
      const out = asObject(input);
      setPath(out, c.field || 'value', min + Math.floor(Math.random() * (max - min + 1)));
      return out;
    },
  },

  chaos: {
    title: 'Chaos Monkey', group: 'Data', icon: '☢', kind: 'action', color: '#fb923c',
    micro: 'Step', outputs: ['main'],
    blurb: 'Passes its input through after a delay, but fails some of the time. Give it retries or a timeout in Settings to watch micro-flow retry it (step_retrying) or time it out.',
    defaults: { fail_pct: 50, latency_ms: 300 },
    fields: [
      { key: 'fail_pct', label: 'Failure chance (%)', kind: 'number' },
      { key: 'latency_ms', label: 'Latency (ms)', kind: 'number' },
    ],
    summary: (c) => `${c.fail_pct}% fail · ${c.latency_ms} ms`,
    async run(input, c, ctx) {
      await ctx.sleep(Number(c.latency_ms) || 0);
      if (Math.random() * 100 < Number(c.fail_pct)) throw new Error('chaos monkey struck');
      return input;
    },
  },

  if: {
    title: 'If', group: 'Logic', icon: '⑂', kind: 'if', color: '#facc15',
    micro: 'ConditionalStep', outputs: ['true', 'false'],
    blurb: 'Compares a value with any of micro-flow\'s comparison operators and runs the true or the false branch. Each branch compiles to its own nested Workflow.',
    defaults: { path: 'value', op: '>', value: '10' },
    fields: [
      { key: 'path', label: 'Value at path', kind: 'text' },
      { key: 'op', label: 'Operator', kind: 'operator' },
      { key: 'value', label: 'Compare with', kind: 'text', show: (c) => needsValue(c.op) },
    ],
    summary: (c) => describeCondition(c.path, c.op, c.value),
  },

  switch: {
    title: 'Switch', group: 'Logic', icon: '⋔', kind: 'switch', color: '#fbbf24',
    micro: 'SwitchStep + Case', inputs: true,
    outputs: (c) => [...(c.cases ?? []).map((_, i) => `case-${i}`), 'default'],
    portLabel: (c, port) => {
      if (port === 'default') return 'default';
      const kase = c.cases?.[Number(port.split('-')[1])];
      return kase ? `${opLabel(kase.op).replace(/ \(.*\)$/, '')} ${needsValue(kase.op) ? kase.value : ''}`.trim() : port;
    },
    blurb: 'Reads one value and runs the first Case that matches it, or the default branch. Every Case is a micro-flow Case step whose callable is a nested Workflow.',
    defaults: { path: 'type', cases: [{ op: '===', value: 'fire' }, { op: '===', value: 'water' }] },
    fields: [
      { key: 'path', label: 'Value at path', kind: 'text' },
      { key: 'cases', label: 'Cases', kind: 'cases' },
    ],
    summary: (c) => `on ${c.path || '$'}`,
  },

  loop: {
    title: 'Loop Over Items', group: 'Flow', icon: '↻', kind: 'loop', color: '#60a5fa',
    micro: 'LoopStep › for_each', outputs: ['each', 'done'],
    blurb: 'Runs the "each" branch once per item of a list (a for_each LoopStep with a function iterable). Inside it, the input is the item, also readable as {{ $item }}. "done" gets the list of results; a Stop If in the branch filters that item out.',
    defaults: { path: '' },
    fields: [{ key: 'path', label: 'List at path (blank = input)', kind: 'text' }],
    summary: (c) => `each of ${c.path || 'input'}`,
  },

  repeat: {
    title: 'Repeat', group: 'Flow', icon: '⟳', kind: 'repeat', color: '#3b82f6',
    micro: 'LoopStep › for', outputs: ['each', 'done'],
    blurb: 'Runs the "each" branch N times (a for LoopStep). Each pass gets the input plus an "index" field. "done" gets the list of results.',
    defaults: { times: 3 },
    fields: [{ key: 'times', label: 'Times', kind: 'number' }],
    summary: (c) => `${c.times} times`,
  },

  wait: {
    title: 'Wait', group: 'Flow', icon: '⏱', kind: 'delay', color: '#94a3b8',
    micro: 'DelayStep › relative', outputs: ['main'],
    blurb: 'Pauses this branch for a number of milliseconds (a relative DelayStep), then passes the input on.',
    defaults: { ms: 500 },
    fields: [{ key: 'ms', label: 'Milliseconds', kind: 'number' }],
    summary: (c) => `${c.ms} ms`,
  },

  stop: {
    title: 'Stop If', group: 'Flow', icon: '⊘', kind: 'break', color: '#ef4444',
    micro: 'FlowControlStep › break', outputs: ['main'],
    blurb: 'If the condition is true, stops the rest of this branch (a break FlowControlStep on the Workflow it sits in). Directly inside a loop, that drops the item, like a filter.',
    defaults: { path: 'value', op: '<', value: '5' },
    fields: [
      { key: 'path', label: 'Value at path', kind: 'text' },
      { key: 'op', label: 'Operator', kind: 'operator' },
      { key: 'value', label: 'Compare with', kind: 'text', show: (c) => needsValue(c.op) },
    ],
    summary: (c) => `stop if ${describeCondition(c.path, c.op, c.value)}`,
  },

  skip: {
    title: 'Skip Next If', group: 'Flow', icon: '⤼', kind: 'skip', color: '#f97316',
    micro: 'FlowControlStep › skip', outputs: ['main'],
    blurb: 'If the condition is true, the next node in this branch is skipped (a skip FlowControlStep) and the one after it runs.',
    defaults: { path: 'value', op: '===', value: '0' },
    fields: [
      { key: 'path', label: 'Value at path', kind: 'text' },
      { key: 'op', label: 'Operator', kind: 'operator' },
      { key: 'value', label: 'Compare with', kind: 'text', show: (c) => needsValue(c.op) },
    ],
    summary: (c) => `skip next if ${describeCondition(c.path, c.op, c.value)}`,
  },

  display: {
    title: 'Display', group: 'Output', icon: '▣', kind: 'action', color: '#34d399',
    micro: 'Step', outputs: ['main'],
    blurb: 'Shows a card in the Output tab and passes its input on. Title, image URL and text can all use {{ path }}.',
    defaults: { title: '{{name}}', image: '', text: '', tone: 'violet' },
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'image', label: 'Image URL', kind: 'text' },
      { key: 'text', label: 'Text', kind: 'text' },
      { key: 'tone', label: 'Colour', kind: 'select', options: TONES },
    ],
    summary: (c) => c.title || c.text || 'card',
    run(input, c, ctx) {
      ctx.display({
        title: String(resolve(c.title, input, ctx) ?? ''),
        image: String(resolve(c.image, input, ctx) ?? ''),
        text: String(resolve(c.text, input, ctx) ?? ''),
        tone: c.tone,
      });
      return input;
    },
  },
};

export const GROUPS = ['Trigger', 'Data', 'Logic', 'Flow', 'Output'];

export const outputsOf = (node) => {
  const outs = NODE_TYPES[node.type].outputs;
  return typeof outs === 'function' ? outs(node.config) : outs;
};

export const portLabel = (node, port) =>
  NODE_TYPES[node.type].portLabel?.(node.config, port) ?? (port === 'main' ? '' : port);
