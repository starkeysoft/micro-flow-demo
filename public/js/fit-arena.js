// Scales fixed-size arenas down to fit narrow screens. Arenas whose contents
// are positioned in pixels (box-tour, the launch scene, the robot worlds) can't
// reflow, so any `.arena[data-fit]` gets a CSS zoom that makes it as wide as the
// page allows (never larger than its natural size).
const GUTTER = 32; // the page's 16px side padding on each side

function fit() {
  const available = document.documentElement.clientWidth - GUTTER;
  for (const arena of document.querySelectorAll('.arena[data-fit]')) {
    arena.style.zoom = '';
    const natural = arena.offsetWidth;
    arena.style.zoom = natural > available ? String(available / natural) : '';
  }
}

fit();
window.addEventListener('resize', fit);
