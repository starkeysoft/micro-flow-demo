// Drives the shared status panel (.status-panel) that every demo shows in the
// top right. Expects #step-type-badge, #step-name and #callable-name elements.
// On phones the panel is a compact bar at the bottom of the screen; tapping it
// toggles the full panel. It also fits the page's arena to narrow screens.
import { fitArenas } from './fit-arena.js';

export function createStatusPanel(step_types = {}) {
  const panel  = document.querySelector('.status-panel');
  const badge  = document.getElementById('step-type-badge');
  const stepEl = document.getElementById('step-name');
  const callEl = document.getElementById('callable-name');

  panel.setAttribute('role', 'button');
  panel.setAttribute('tabindex', '0');
  panel.setAttribute('aria-expanded', 'false');
  const toggle = () => {
    const expanded = panel.classList.toggle('expanded');
    panel.setAttribute('aria-expanded', String(expanded));
  };
  panel.addEventListener('click', toggle);
  panel.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  fitArenas();

  // The badge label comes from badge_label if given, else step_types[step],
  // else "Step".
  return function status(step, callable, badge_label) {
    stepEl.textContent = step;
    callEl.textContent = callable;
    badge.textContent  = badge_label ?? step_types[step] ?? 'Step';
  };
}
