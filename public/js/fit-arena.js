// Shrinks fixed-geometry arenas to fit narrow screens. Arenas marked
// `data-fit` keep their 640×400 layout (their contents are positioned in
// pixels) and get a CSS zoom so they fit the page width with 16px gutters.
const ARENA_WIDTH = 640;
const GUTTERS = 32;

export function fitArenas() {
  const arenas = document.querySelectorAll('.arena[data-fit]');
  if (!arenas.length) return;

  const fit = () => {
    const available = document.documentElement.clientWidth - GUTTERS;
    const zoom = Math.min(1, available / ARENA_WIDTH);
    for (const arena of arenas) arena.style.zoom = zoom < 1 ? zoom.toFixed(4) : '';
  };

  fit();
  window.addEventListener('resize', fit);
}
