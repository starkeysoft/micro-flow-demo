// Starter flows for flow-canvas. Every API here allows CORS and needs no key.
// Nodes: { id, type, name, x, y, config, settings }. Edges: { id, from, port, to }.

const node = (id, type, name, x, y, config = {}, settings = {}) =>
  ({ id, type, name, x, y, config, settings: { retries: 0, timeout_ms: '', ...settings } });
const edge = (from, port, to) => ({ id: `${from}.${port}>${to}`, from, port, to });

export const TEMPLATES = {
  pokemon: {
    title: 'Pokémon type sorter',
    name: 'pokemon-type-sorter',
    options: { exit_on_error: true },
    nodes: [
      node('t', 'trigger', 'Start', 40, 220, { json: '{ "party": "random" }' }),
      node('r', 'repeat', 'Draw 6', 260, 220, { times: 6 }),
      node('n', 'random', 'Pick a number', 500, 120, { field: 'id', min: 1, max: 1025 }),
      node('h', 'http', 'Fetch Pokémon', 730, 120, { url: 'https://pokeapi.co/api/v2/pokemon/{{id}}' }, { retries: 2, timeout_ms: 10000 }),
      node('s', 'set', 'Keep the basics', 960, 120, {
        mode: 'replace',
        assignments: 'name = {{name}}\ntype = {{types[0].type.name}}\nsprite = {{sprites.front_default}}\nhp = {{stats[0].base_stat}}\nslot = {{$item.index}}',
      }),
      node('w', 'switch', 'By type', 1190, 120, {
        path: 'type',
        cases: [{ op: '===', value: 'fire' }, { op: '===', value: 'water' }, { op: 'in', value: 'grass, bug' }],
      }),
      node('d1', 'display', 'Fire card', 1460, -40, { title: '{{name}}', image: '{{sprite}}', text: 'fire · HP {{hp}}', tone: 'red' }),
      node('d2', 'display', 'Water card', 1460, 80, { title: '{{name}}', image: '{{sprite}}', text: 'water · HP {{hp}}', tone: 'blue' }),
      node('d3', 'display', 'Leafy card', 1460, 200, { title: '{{name}}', image: '{{sprite}}', text: '{{type}} · HP {{hp}}', tone: 'green' }),
      node('d4', 'display', 'Other card', 1460, 320, { title: '{{name}}', image: '{{sprite}}', text: '{{type}} · HP {{hp}}', tone: 'slate' }),
      node('c', 'transform', 'Total HP', 500, 380, { op: 'sum', path: '', field: 'hp' }),
      node('d5', 'display', 'Summary', 730, 380, { title: 'Party drawn', text: 'six Pokémon, {{$}} HP in total', tone: 'violet' }),
    ],
    edges: [
      edge('t', 'main', 'r'), edge('r', 'each', 'n'), edge('n', 'main', 'h'), edge('h', 'main', 's'),
      edge('s', 'main', 'w'), edge('w', 'case-0', 'd1'), edge('w', 'case-1', 'd2'), edge('w', 'case-2', 'd3'),
      edge('w', 'default', 'd4'), edge('r', 'done', 'c'), edge('c', 'main', 'd5'),
    ],
  },

  weather: {
    title: 'Weather board',
    name: 'weather-board',
    options: { exit_on_error: true },
    nodes: [
      node('t', 'trigger', 'Cities', 40, 160, {
        json: JSON.stringify({ cities: [
          { name: 'London', lat: 51.51, lon: -0.13 },
          { name: 'Cairo', lat: 30.04, lon: 31.24 },
          { name: 'Reykjavík', lat: 64.15, lon: -21.94 },
          { name: 'Singapore', lat: 1.35, lon: 103.82 },
          { name: 'Denver', lat: 39.74, lon: -104.99 },
        ] }, null, 2),
      }),
      node('l', 'loop', 'Each city', 270, 160, { path: 'cities' }),
      node('h', 'http', 'Open-Meteo', 500, 60, {
        url: 'https://api.open-meteo.com/v1/forecast?latitude={{lat}}&longitude={{lon}}&current=temperature_2m,wind_speed_10m',
      }, { retries: 2, timeout_ms: 10000 }),
      node('s', 'set', 'Shape', 730, 60, {
        mode: 'replace',
        assignments: 'city = {{$item.name}}\ntemp = {{current.temperature_2m}}\nwind = {{current.wind_speed_10m}}',
      }),
      node('i', 'if', 'Warm?', 960, 60, { path: 'temp', op: '>', value: '18' }),
      node('d1', 'display', 'Warm card', 1200, -30, { title: '{{city}}', text: '{{temp}} °C · wind {{wind}} km/h', tone: 'amber' }),
      node('d2', 'display', 'Cool card', 1200, 110, { title: '{{city}}', text: '{{temp}} °C · wind {{wind}} km/h', tone: 'blue' }),
      node('x', 'transform', 'Warmest first', 500, 300, { op: 'sort', path: '', field: 'temp' }),
      node('y', 'transform', 'Pick last', 730, 300, { op: 'get', path: '[4].city' }),
      node('d3', 'display', 'Winner', 960, 300, { title: 'Warmest: {{$}}', text: 'sorted by the Transform node', tone: 'violet' }),
    ],
    edges: [
      edge('t', 'main', 'l'), edge('l', 'each', 'h'), edge('h', 'main', 's'), edge('s', 'main', 'i'),
      edge('i', 'true', 'd1'), edge('i', 'false', 'd2'), edge('l', 'done', 'x'), edge('x', 'main', 'y'),
      edge('y', 'main', 'd3'),
    ],
  },

  dogs: {
    title: 'Dog gallery',
    name: 'dog-gallery',
    options: { exit_on_error: true },
    nodes: [
      node('t', 'trigger', 'Start', 40, 140, { json: '{}' }),
      node('h', 'http', 'Six dogs', 260, 140, { url: 'https://dog.ceo/api/breeds/image/random/6' }, { retries: 1 }),
      node('l', 'loop', 'Each photo', 490, 140, { path: 'message' }),
      node('b', 'set', 'Wrap URL', 720, 40, { mode: 'replace', assignments: 'url = {{$}}' }),
      node('m', 'transform', 'Breed from URL', 950, 40, { op: 'match', path: 'url', field: 'breeds/([^/]+)/', into: 'breed' }),
      node('w', 'wait', 'Suspense', 1180, 40, { ms: 400 }),
      node('d', 'display', 'Photo', 1400, 40, { title: '{{breed}}', image: '{{url}}', text: '', tone: 'green' }),
      node('d2', 'display', 'Count', 720, 260, { title: 'Gallery done', text: '{{length}} dogs shown', tone: 'violet' }),
    ],
    edges: [
      edge('t', 'main', 'h'), edge('h', 'main', 'l'), edge('l', 'each', 'b'), edge('b', 'main', 'm'),
      edge('m', 'main', 'w'), edge('w', 'main', 'd'), edge('l', 'done', 'd2'),
    ],
  },

  flaky: {
    title: 'Flaky API (retries + filter)',
    name: 'flaky-api',
    options: { exit_on_error: false },
    nodes: [
      node('t', 'trigger', 'Start', 40, 160, { json: '{ "calls": "eight" }' }),
      node('r', 'repeat', 'Eight calls', 260, 160, { times: 8 }),
      node('c', 'chaos', 'Unreliable API', 500, 60, { fail_pct: 45, latency_ms: 250 }, { retries: 2 }),
      node('n', 'random', 'Score', 730, 60, { field: 'score', min: 1, max: 10 }),
      node('s', 'stop', 'Drop low scores', 960, 60, { path: 'score', op: '<', value: '4' }),
      node('d', 'display', 'Result', 1190, 60, { title: 'Call #{{index}}', text: 'score {{score}}', tone: 'green' }),
      node('x', 'transform', 'Count kept', 500, 300, { op: 'length', path: '' }),
      node('d2', 'display', 'Summary', 730, 300, { title: '{{$}} of 8 calls kept', text: 'failed calls and scores under 4 were dropped', tone: 'amber' }),
    ],
    edges: [
      edge('t', 'main', 'r'), edge('r', 'each', 'c'), edge('c', 'main', 'n'), edge('n', 'main', 's'),
      edge('s', 'main', 'd'), edge('r', 'done', 'x'), edge('x', 'main', 'd2'),
    ],
  },
};
