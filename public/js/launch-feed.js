// Turns micro-flow events into the step timeline, event log and status panel.
// The mission tab feeds it local events (Workflow.events.*.on) and the
// observer tab feeds it cross-tab broadcasts (Workflow.events.*.onBroadcast).
// Event payloads are the emitter's serialized form: a step's
// prepareForSerialization() for step events, the workflow's for most
// workflow events.

export const TOP_WORKFLOW = 'launch-sequence';
export const SUB_WORKFLOW = 'ascent';
const MAX_LOG_ENTRIES = 250;

// Custom events (not micro-flow's own) for an observer that opens mid-launch:
// it emits SNAPSHOT_REQUEST, and the mission tab answers by emitting
// SNAPSHOT_EVENT with its current workflow. Workflow.events.workflow.emit()
// broadcasts any event name to other tabs, not only the built-in ones.
export const SNAPSHOT_REQUEST = 'launch_snapshot_request';
export const SNAPSHOT_EVENT = 'launch_snapshot';

// Badge label from a serialized step.
export function badgeFor(step) {
  switch (step.class_name) {
    case 'loop':         return `LoopStep › ${step.loop_type}`;
    case 'delay':        return `DelayStep › ${step.delay_type}`;
    case 'switch':       return 'SwitchStep';
    case 'case':         return 'Case';
    case 'flow_control': return `FlowControlStep › ${step.flow_control_type}`;
    case 'conditional':  return 'ConditionalStep';
    default:             return step.callable_type === 'workflow' ? 'Step › Workflow' : 'Step';
  }
}

// Default Callable line for a step that just started.
function describe(step) {
  if (step.class_name === 'delay') {
    return step.delay_type === 'absolute'
      ? `until ${new Date(step.absolute_timestamp).toLocaleTimeString()}`
      : `${step.relative_delay_ms} ms`;
  }
  if (step.callable_type === 'workflow') return `sub-workflow "${step.callable?.value?.name ?? ''}"`;
  return 'running';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createFeed({ timelineEl, logEl, status, onEvent = () => {} }) {
  const rows = new Map(); // top-level step id → { el, chip, meta, name, retries }
  let order = [];         // top-level step ids in run order
  let current = null;     // { name, badge } of the step the status panel shows
  let running_row = null; // top-level row that nested/inner events belong to
  let did_break = false;  // a break still ends in workflow_complete

  function log(event_name, subject, { nested = false, tone = '' } = {}) {
    const entry = el('li', `log-entry ${nested ? 'nested' : ''} ${tone}`);
    const time = new Date().toLocaleTimeString([], { hour12: false }) +
      '.' + String(new Date().getMilliseconds()).padStart(3, '0');
    entry.append(el('span', 'log-time', time), el('span', 'log-event', event_name), el('span', 'log-subject', subject));
    logEl.append(entry);
    while (logEl.children.length > MAX_LOG_ENTRIES) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setChip(row, state) {
    row.chip.textContent = state;
    row.chip.className = `chip chip-${state.replace(' ', '-')}`;
  }

  function renderMeta(row, step) {
    const parts = [];
    if (row.retries) parts.push(`${row.retries} ${row.retries === 1 ? 'retry' : 'retries'}`);
    if (step?.timing?.execution_time_ms != null) parts.push(`${step.timing.execution_time_ms} ms`);
    row.meta.textContent = parts.join(' · ');
  }

  // Build the timeline from a serialized workflow's steps (keeps any
  // statuses restored by hydration).
  function seed(workflow) {
    timelineEl.replaceChildren();
    rows.clear();
    order = workflow.steps.map((s) => s.id);
    workflow.steps.forEach((step, i) => {
      const item  = el('li', 'timeline-row');
      const chip  = el('span', 'chip');
      const meta  = el('span', 'timeline-meta');
      const label = el('div', 'timeline-label');
      label.append(el('span', 'timeline-name', `${String(i + 1).padStart(2, '0')} ${step.name}`), el('span', 'timeline-type', badgeFor(step)));
      item.append(label, meta, chip);
      timelineEl.append(item);
      const row = { el: item, chip, meta, name: step.name, retries: 0 };
      rows.set(step.id, row);
      setChip(row, ['complete', 'failed', 'running'].includes(step.status) ? step.status : 'pending');
      if (step.status === 'running') running_row = row;
      renderMeta(row, step);
    });
  }

  // Seed from a snapshot of a workflow that may already be running or done
  // (see SNAPSHOT_EVENT). A finished workflow's unrun steps are "not run".
  function handleSnapshot(wf) {
    seed(wf);
    if (wf.status === 'complete' || wf.status === 'failed') markRemaining('not run');
    const running = wf.steps.find((step) => step.status === 'running');
    if (running) {
      current = { name: running.name, badge: badgeFor(running) };
      status(running.name, 'running (joined mid-step)', current.badge);
    } else {
      status(wf.name, wf.status, `Workflow › ${wf.status}`);
    }
    log(SNAPSHOT_EVENT, `${wf.name} — ${wf.status}`, { tone: 'good' });
  }

  function markRemaining(state) {
    for (const id of order) {
      const row = rows.get(id);
      if (row.chip.textContent === 'pending' || row.chip.textContent === 'running') setChip(row, state);
    }
  }

  function handleWorkflowEvent(event_name, detail) {
    // Most workflow events carry the workflow; skip/break carry { workflow, step },
    // and pause/resume carry the instance state ({ workflow, ... }).
    const wf = detail?.steps ? detail : detail?.workflow;
    if (!wf) return;
    const is_top = wf.name === TOP_WORKFLOW;
    onEvent('workflow', event_name, wf);

    if (event_name === 'workflow_created') return; // noisy, and emitted before any steps exist
    if (event_name === 'workflow_running' && is_top) { seed(wf); did_break = false; }

    let tone = '';
    let subject = wf.name;
    if (event_name === 'workflow_paused') {
      // Emitted once the workflow has actually stopped at a step boundary.
      subject = `${wf.name} — paused`;
      tone = 'warn';
      if (is_top) status(wf.name, 'paused at a step boundary', 'Workflow');
    }
    if (event_name === 'workflow_resumed' && is_top) status(wf.name, 'resuming', 'Workflow');
    if (event_name === 'workflow_step_skipped' && is_top) {
      // Skip and break events carry { workflow, step }.
      const row = rows.get(detail.step?.id);
      if (row) { setChip(row, 'skipped'); subject = `${wf.name} — skipped ${row.name}`; }
      tone = 'warn';
    }
    if (event_name === 'workflow_break_executed' && is_top) {
      markRemaining('not run');
      did_break = true;
      subject = `${wf.name} — break`;
      tone = 'warn';
      status(wf.name, 'break — remaining steps not run', 'FlowControlStep › break');
    }
    if (event_name === 'workflow_failed') {
      tone = 'bad';
      if (is_top) {
        markRemaining('not run');
        status(wf.name, 'failed — exit_on_error stopped the run', 'Workflow › failed');
      }
    }
    if (event_name === 'workflow_complete') {
      tone = 'good';
      if (is_top) {
        status(wf.name, did_break ? 'complete — ended early by a break' : 'complete', 'Workflow › complete');
      }
    }

    log(event_name, subject, { nested: !is_top, tone });
  }

  function handleStepEvent(event_name, step) {
    onEvent('step', event_name, step);
    const row = rows.get(step.id);

    if (event_name === 'step_running') {
      current = { name: step.name, badge: badgeFor(step) };
      status(step.name, describe(step), current.badge);
      if (row) { running_row = row; setChip(row, 'running'); }
    }
    if (event_name === 'step_retrying') {
      // A retry of a nested step (e.g. check-guidance) counts toward the
      // top-level row that is running it.
      const target = row ?? running_row;
      if (target) { target.retries += 1; renderMeta(target); }
      status(step.name, `retry ${step.retry_count} of ${step.max_retries}`, badgeFor(step));
    }
    if (row && event_name === 'step_complete') { setChip(row, 'complete'); renderMeta(row, step); }
    if (row && event_name === 'step_failed')   { setChip(row, 'failed'); renderMeta(row, step); }

    let tone = '';
    if (event_name === 'step_failed') tone = 'bad';
    if (event_name === 'step_retrying') tone = 'warn';
    const suffix = event_name === 'step_retrying' ? ` (retry ${step.retry_count} of ${step.max_retries})` : '';
    log(event_name, step.name + suffix, { nested: !row, tone });
  }

  // Lets callables set the Callable line for whichever step is running.
  function note(text) {
    if (current) status(current.name, text, current.badge);
  }

  function reset() {
    timelineEl.replaceChildren();
    logEl.replaceChildren();
    rows.clear();
    order = [];
    current = null;
    running_row = null;
  }

  return { handleWorkflowEvent, handleStepEvent, handleSnapshot, note, reset, log };
}
