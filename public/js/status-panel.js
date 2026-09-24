// Drives the shared status panel (.status-panel) that every demo shows in the
// top right. Expects #step-type-badge, #step-name and #callable-name elements.
export function createStatusPanel(step_types = {}) {
  const badge  = document.getElementById('step-type-badge');
  const stepEl = document.getElementById('step-name');
  const callEl = document.getElementById('callable-name');

  // The badge label comes from badge_label if given, else step_types[step],
  // else "Step".
  return function status(step, callable, badge_label) {
    stepEl.textContent = step;
    callEl.textContent = callable;
    badge.textContent  = badge_label ?? step_types[step] ?? 'Step';
  };
}
