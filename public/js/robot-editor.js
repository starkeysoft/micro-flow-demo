// Block editor for robot-builder. It draws straight from the live Workflow tree
// (workflow.steps is the only source of truth) and applies every structural
// edit through micro-flow's step API: addStep, addStepAtIndex, moveStep,
// deleteStepByIndex. Setting changes go through `ops` (see robot-builder.js).

export const TITLES = {
  move: 'move forward',
  left: 'turn left',
  right: 'turn right',
  paint: 'paint',
  repeat: 'repeat',
  while: 'repeat while',
  if: 'if',
  switch: 'switch on',
};

export const SENSOR_NAMES = ['ahead', 'left', 'right', 'here', 'facing', 'moves'];
export const OPERATORS = ['===', '!==', 'in', 'not_in', '<', '>=', 'regex_match', 'string_starts_with'];

const ADDABLE = ['move', 'left', 'right', 'paint', 'repeat', 'while', 'if', 'switch'];

export function defaultBlock(kind) {
  switch (kind) {
    case 'repeat': return { kind, times: 3, body: [{ kind: 'move' }] };
    case 'while':  return { kind, cond: { sensor: 'ahead', op: '!==', value: 'wall' }, body: [{ kind: 'move' }] };
    case 'if':     return { kind, cond: { sensor: 'ahead', op: '===', value: 'wall' }, then: [{ kind: 'right' }], else: [{ kind: 'move' }] };
    case 'switch': return { kind, sensor: 'ahead', cases: [{ value: 'wall', body: [{ kind: 'right' }] }], default: [{ kind: 'move' }] };
    default:       return { kind };
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function select(options, value, onChange) {
  const node = el('select', 'block-input');
  for (const option of options) node.append(new Option(option, option));
  node.value = value;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function iconButton(label, title, onClick, disabled = false) {
  const node = el('button', 'icon-button', label);
  node.type = 'button';
  node.title = title;
  node.setAttribute('aria-label', title);
  node.disabled = disabled;
  node.addEventListener('click', onClick);
  return node;
}

export function createEditor({ root, program, meta, ops, onChange }) {
  const changed = () => onChange({ rerender: true });
  const tweaked = () => onChange({ rerender: false });

  function conditionInputs(step, cond) {
    const update = (patch) => { ops.setCondition(step, { ...meta.get(step).cond, ...patch }); tweaked(); };
    const value = el('input', 'block-input block-value');
    value.value = cond.value;
    value.placeholder = 'value';
    value.addEventListener('change', () => update({ value: value.value }));
    return [
      select(SENSOR_NAMES, cond.sensor, (sensor) => update({ sensor })),
      select(OPERATORS, cond.op, (op) => update({ op })),
      value,
    ];
  }

  function section(wf, label, extra = []) {
    const node = el('div', 'block-body');
    node.dataset.wfId = wf.id;
    const head = el('div', 'body-label');
    if (label) head.append(el('span', '', label));
    head.append(...extra);
    node.append(head, list(wf));
    return node;
  }

  function block(wf, step, index) {
    const m = meta.get(step);
    const li = el('li', `block block-${m.kind}`);
    li.dataset.stepId = step.id;

    const head = el('div', 'block-head');
    head.append(el('span', 'block-kind', TITLES[m.kind]));

    if (m.kind === 'repeat') {
      const times = el('input', 'block-input block-times');
      times.type = 'number';
      times.min = 1;
      times.max = 99;
      times.value = m.times;
      times.addEventListener('change', () => {
        ops.setTimes(step, Math.max(1, Math.min(99, Number(times.value) || 1)));
        tweaked();
      });
      head.append(times, el('span', 'block-kind', 'times'));
    }
    if (m.kind === 'while' || m.kind === 'if') head.append(...conditionInputs(step, m.cond));
    if (m.kind === 'switch') {
      head.append(select(SENSOR_NAMES, m.sensor, (sensor) => { ops.setSwitchSensor(step, sensor); tweaked(); }));
    }
    if (m.kind === 'repeat' || m.kind === 'while') {
      const iter = el('span', 'block-iter');
      iter.dataset.iterFor = step.id;
      head.append(iter);
    }

    const last = wf.steps.length - 1;
    const controls = el('span', 'block-controls');
    controls.append(
      iconButton('↑', 'Move up (moveStep)', () => { wf.moveStep(index, index - 1); changed(); }, index === 0),
      iconButton('↓', 'Move down (moveStep)', () => { wf.moveStep(index, index + 1); changed(); }, index === last),
      iconButton('⧉', 'Duplicate (addStepAtIndex)', () => {
        wf.addStepAtIndex(ops.buildStep(ops.blockOf(step)), index + 1);
        changed();
      }),
      iconButton('✕', 'Delete (deleteStepByIndex)', () => { wf.deleteStepByIndex(index); changed(); }),
    );
    head.append(controls);
    li.append(head);

    if (m.kind === 'repeat' || m.kind === 'while') li.append(section(m.body, 'do'));
    if (m.kind === 'if') li.append(section(m.then, 'then'), section(m.else, 'else'));
    if (m.kind === 'switch') {
      m.cases.forEach((c, i) => {
        const value = el('input', 'block-input block-value');
        value.value = c.value;
        value.addEventListener('change', () => { ops.setCaseValue(step, i, value.value); tweaked(); });
        const remove = iconButton('✕', 'Remove case', () => { ops.removeCase(step, i); changed(); });
        const node = section(c.body, 'case ===', [value, remove]);
        node.dataset.stepId = c.step.id; // the Case step's events light this up
        li.append(node);
      });
      const add = el('button', 'text-button', '+ case');
      add.type = 'button';
      add.addEventListener('click', () => { ops.addCase(step); changed(); });
      li.append(add, section(m.default, 'default'));
    }
    return li;
  }

  function list(wf) {
    const ol = el('ol', 'block-list');
    wf.steps.forEach((step, i) => ol.append(block(wf, step, i)));

    const add = el('select', 'block-input block-add');
    add.append(new Option('+ add block…', ''));
    for (const kind of ADDABLE) add.append(new Option(TITLES[kind], kind));
    add.addEventListener('change', () => {
      if (!add.value) return;
      wf.addStep(ops.buildStep(defaultBlock(add.value)));
      changed();
    });
    const li = el('li', 'block-add-row');
    li.append(add);
    ol.append(li);
    return ol;
  }

  function render() {
    const clear = el('button', 'text-button clear-button', 'clear program (clearSteps)');
    clear.type = 'button';
    clear.addEventListener('click', () => { program.clearSteps(); changed(); });
    root.replaceChildren(list(program), clear);
  }

  const find = (selector) => root.querySelector(selector);

  return {
    render,
    mark(step_id, state) {
      const node = find(`[data-step-id="${step_id}"]`);
      if (!node) return;
      node.classList.remove('running', 'done', 'failed');
      node.classList.add(state);
    },
    markBody(wf_id) {
      find(`[data-wf-id="${wf_id}"]`)?.classList.add('taken');
    },
    setIteration(step_id, text) {
      const node = find(`[data-iter-for="${step_id}"]`);
      if (node) node.textContent = text;
    },
    clearMarks() {
      for (const node of root.querySelectorAll('.running, .done, .failed, .taken')) {
        node.classList.remove('running', 'done', 'failed', 'taken');
      }
      for (const node of root.querySelectorAll('.block-iter')) node.textContent = '';
    },
  };
}
