import {
  Workflow,
  Step,
  LoopStep,
  ConditionalStep,
} from 'micro-flow';
import { createStatusPanel } from './status-panel.js';

const API = 'https://pokeapi.co/api/v2';
const PARTY_SIZE = 6;
const FALLBACK_SPECIES_COUNT = 1025; // used if the count request fails

const partyEl   = document.getElementById('party');
const refreshEl = document.getElementById('refresh');
const partiesEl = document.getElementById('parties');

const status = createStatusPanel({
  'prepare-party':       'Step',
  'check-species-count': 'ConditionalStep',
  'pick-ids':            'Step',
  'fetch-pokemon':       'LoopStep › for_each',
  'check-failures':      'ConditionalStep',
  'finish-party':        'Step',
});

const STAT_LABELS = {
  'hp':              'HP',
  'attack':          'ATK',
  'defense':         'DEF',
  'special-attack':  'SP.ATK',
  'special-defense': 'SP.DEF',
  'speed':           'SPD',
};
const MAX_BASE_STAT = 255;

// --- State shared across workflow runs ---
let species_count = null; // fetched once, then reused
let parties = 0;

// --- Per-run state (reset by prepare-party) ---
let picked_ids = [];
let failures = 0;

// --- Card rendering ---
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function placeholderCard() {
  const card  = el('div', 'card loading');
  const inner = el('div', 'card-inner');
  inner.append(el('div', 'card-face card-front'));
  card.append(inner);
  return card;
}

function errorCard(id) {
  const card  = el('div', 'card error');
  const inner = el('div', 'card-inner');
  inner.append(el('div', 'card-face card-front', `Couldn't load #${id}`));
  card.append(inner);
  return card;
}

function pokemonCard(p) {
  const card = el('div', 'card ready');
  card.tabIndex = 0;
  card.setAttribute('aria-label', `${p.name}, #${p.id}. Hover or focus to see stats.`);
  // Hover and focus flip via CSS; a tap toggles it on touch screens.
  card.addEventListener('click', () => card.classList.toggle('flipped'));

  const inner = el('div', 'card-inner');

  const front = el('div', 'card-face card-front');
  const img = el('img');
  img.src = p.sprites.other?.['official-artwork']?.front_default ?? p.sprites.front_default ?? '';
  img.alt = p.name;
  front.append(img, el('div', 'card-name', p.name), el('div', 'card-id', `#${p.id}`));

  const back = el('div', 'card-face card-back');
  back.append(el('div', 'card-name', p.name));

  const types = el('div', 'types');
  for (const t of p.types) types.append(el('span', 'type', t.type.name));
  back.append(types);

  for (const s of p.stats) {
    const row = el('div', 'stat');
    const bar = el('div', 'stat-bar');
    const fill = el('span');
    fill.style.width = `${Math.min(100, (s.base_stat / MAX_BASE_STAT) * 100)}%`;
    bar.append(fill);
    row.append(
      el('span', 'stat-label', STAT_LABELS[s.stat.name] ?? s.stat.name),
      el('span', 'stat-num', s.base_stat),
      bar,
    );
    back.append(row);
  }

  // PokeAPI reports height in decimetres and weight in hectograms.
  back.append(el('div', 'card-measures', `${(p.height / 10).toFixed(1)} m · ${(p.weight / 10).toFixed(1)} kg`));

  inner.append(front, back);
  card.append(inner);
  return card;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// --- Workflow factory (recreated on every refresh) ---
function buildWorkflow() {
  return new Workflow({
    name: 'pokemon-party',
    steps: [

      // 1. STEP — reset per-run state, show placeholder cards
      new Step({
        name: 'prepare-party',
        callable: async () => {
          status('prepare-party', 'render-placeholders');
          picked_ids = [];
          failures = 0;
          partyEl.replaceChildren(...Array.from({ length: PARTY_SIZE }, placeholderCard));
        },
      }),

      // 2. CONDITIONAL STEP — fetch the species count on the first run only
      new ConditionalStep({
        name: 'check-species-count',
        conditional: {
          subject: () => species_count,
          operator: '===',
          value: null,
        },
        true_callable: async () => {
          status('check-species-count', 'true-branch — fetching species count');
          try {
            const { count } = await getJSON(`${API}/pokemon-species?limit=1`);
            species_count = count;
          } catch (error) {
            console.error(error);
            species_count = FALLBACK_SPECIES_COUNT;
          }
        },
        false_callable: async () => {
          status('check-species-count', `false-branch — cached (${species_count})`);
        },
      }),

      // 3. STEP — choose PARTY_SIZE distinct random national dex numbers
      new Step({
        name: 'pick-ids',
        callable: async () => {
          const ids = new Set();
          while (ids.size < PARTY_SIZE) {
            ids.add(1 + Math.floor(Math.random() * species_count));
          }
          picked_ids = [...ids];
          status('pick-ids', picked_ids.map((id) => `#${id}`).join(' '));
        },
      }),

      // 4. LOOP STEP — fetch each pokémon and swap its card in as it arrives
      new LoopStep({
        name: 'fetch-pokemon',
        loop_type: 'for_each',
        iterable: () => picked_ids,
        callable: async function () {
          const id = this.current_item;
          const index = this.results.length;
          status('fetch-pokemon', `#${id} (${index + 1} of ${PARTY_SIZE})`);

          try {
            const pokemon = await getJSON(`${API}/pokemon/${id}`);
            partyEl.children[index].replaceWith(pokemonCard(pokemon));
            return pokemon.name;
          } catch (error) {
            console.error(error);
            failures += 1;
            partyEl.children[index].replaceWith(errorCard(id));
            return null;
          }
        },
      }),

      // 5. CONDITIONAL STEP — report whether every fetch succeeded
      new ConditionalStep({
        name: 'check-failures',
        conditional: {
          subject: () => failures,
          operator: '>',
          value: 0,
        },
        true_callable: async () => {
          status('check-failures', `true-branch — ${failures} failed, refresh to retry`);
        },
        false_callable: async () => {
          status('check-failures', `false-branch — all ${PARTY_SIZE} loaded`);
        },
      }),

      // 6. STEP — bump the counter
      new Step({
        name: 'finish-party',
        callable: async () => {
          parties += 1;
          partiesEl.textContent = parties;
        },
      }),
    ],
  });
}

// --- Run on load and on every refresh ---
async function drawParty() {
  refreshEl.disabled = true;
  try {
    await buildWorkflow().execute();
  } finally {
    refreshEl.disabled = false;
  }
}

refreshEl.addEventListener('click', () => drawParty().catch(console.error));
drawParty().catch(console.error);
