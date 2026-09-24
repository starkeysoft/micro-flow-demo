import { Workflow } from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { createFeed, TOP_WORKFLOW, SUB_WORKFLOW, SNAPSHOT_REQUEST, SNAPSHOT_EVENT } from './launch-feed.js';

// This page runs no workflow. micro-flow's Event.emit() also posts every
// event to a BroadcastChannel named after the event, so onBroadcast() here
// receives the events that the launch-control tab emits.

const noteEl = document.getElementById('observer-note');
const receivedEl = document.getElementById('received');

const status = createStatusPanel();
const feed = createFeed({
  timelineEl: document.getElementById('timeline'),
  logEl: document.getElementById('log'),
  status,
});

// Other demo tabs broadcast on the same channels, so keep only launch
// workflows and their steps. Steps are matched by parent_workflow_id; the
// standalone check-* steps and the Case's wind-hold DelayStep have no parent,
// so they are matched by name.
const WORKFLOW_NAMES = new Set([TOP_WORKFLOW, SUB_WORKFLOW]);
const workflow_ids = new Set();
const isLaunchStep = (step) =>
  workflow_ids.has(step.parent_workflow_id) ||
  step.name?.startsWith('check-') ||
  step.name?.startsWith('case-') ||
  step.name === 'wind-hold';

// Record a workflow's id (and its sub-workflow's, from the nested callable)
// so its steps pass isLaunchStep().
function learnIds(wf) {
  workflow_ids.add(wf.id);
  for (const step of wf.steps ?? []) {
    if (step.callable?.type === 'workflow') workflow_ids.add(step.callable.value.id);
  }
}

let received = 0;
function count() {
  received += 1;
  receivedEl.textContent = received;
  if (received === 1) {
    noteEl.textContent = 'Live: mirroring broadcasts from a launch-control tab.';
    noteEl.classList.add('live');
  }
}

for (const name of Object.values(Workflow.event_names.workflow)) {
  Workflow.events.workflow.onBroadcast(name, (detail) => {
    const wf = detail?.steps ? detail : detail?.workflow;
    if (!wf || !WORKFLOW_NAMES.has(wf.name)) return;
    learnIds(wf);
    count();
    feed.handleWorkflowEvent(name, detail);
  });
}

for (const name of Object.values(Workflow.event_names.step)) {
  Workflow.events.step.onBroadcast(name, (step) => {
    if (!isLaunchStep(step)) return;
    count();
    feed.handleStepEvent(name, step);
  });
}

// Catch up with a launch that's already in progress (or finished) in another tab.
Workflow.events.workflow.onBroadcast(SNAPSHOT_EVENT, (wf) => {
  if (wf?.name !== TOP_WORKFLOW) return;
  learnIds(wf);
  count();
  feed.handleSnapshot(wf);
});
Workflow.events.workflow.emit(SNAPSHOT_REQUEST, { requested_at: new Date().toISOString() });
