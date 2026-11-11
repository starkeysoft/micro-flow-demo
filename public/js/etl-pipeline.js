import { Workflow, Step, LoopStep } from 'micro-flow';
import { createStatusPanel } from './status-panel.js';
import { createServerStatus } from './server-status.js';
import { badgeFor } from './launch-feed.js';

const $ = (id) => document.getElementById(id);
const csvEl = $('csv');
const runBtn = $('run');
const thresholdEl = $('threshold');
const flakyEl = $('flaky');
const requestEl = $('request-line');

const status = createStatusPanel();
const server = createServerStatus({ demo: 'etl' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Sample sources ---
const SAMPLES = {
  // 40 rows; 6 should be rejected (15%), so it passes the default 20% gate.
  messy: `order_id,date,customer_email,country,amount,currency
A1001,2026-03-04,ana.silva@example.com,US,"$1,204.50",USD
A1002,04/03/2026,  Ben.Okafor@Example.com ,United States,89,USD
A1003,Mar 4 2026,chloe@example.de,DE,"1.204,50",EUR
A1004,2026-03-05,DAVID@EXAMPLE.CO.UK,uk,£45.00,GBP
A1005,2026/03/05,eva@example.fr,France,"12,5",EUR
A1006,05/03/2026,farid@example.com,germany,310,EUR
A1007,"March 6, 2026",gia@example.it,Italy,99.99,EUR
A1008,2026-03-06,hiro@example.jp,JP,"¥12,800",JPY
A1009,2026-03-06,isla@example.ca,canada,"1,050.00",CAD
A1010,07/03/2026,jonas@example.nl,NL,74.20,EUR
A1011,2026-03-07,kate@example,US,120,USD
A1012,2026-03-07,liam@example.com,usa,-40,USD
A1013,Mar 8 2026,maya@example.com,United States,,USD
A1014,2026-03-08,noah@example.com,US,250,BTC
A1015,2026-03-08,olivia@example.es,Spain,"2.300,00",EUR
A1016,08/03/2026,pablo@example.es,es,18,EUR
A1017,2026-03-09,quinn@example.com,Australia,65,USD
A1018,2026-03-09, Rosa@Example.com,US,"$2,999.00",
A1019,Mar 9 2026,sam@example.co.uk,United Kingdom,430,GBP
A1020,2026-03-10,tara@example.com,US,15.75,usd
A1003,2026-03-10,chloe@example.de,DE,"1.250,00",EUR
A1021,10/03/2026,umar@example.com,canada,88,CAD
A1022,2026-03-10,vera@example.de,Deutschland,560,EUR
A1023,2026-03-11,will@example.com,us,42,USD
A1024,next tuesday,xena@example.com,US,77,USD
A1025,2026-03-11,yusuf@example.fr,FR,"1 150,00",EUR
A1026,11/03/2026,zoe@example.com,US,"$310",USD
A1027,2026-03-12,adam@example.jp,japan,"3,400",JPY
A1028,Mar 12 2026,bea@example.nl,holland,49.5,EUR
A1029,2026-03-12,carl@example.com,United States,1999,USD
A1030,12/03/2026,dina@example.co.uk,GB,£12.99,GBP
A1031,2026-03-13,ethan@example.ca,CA,"2,045.10",CAD
A1032,2026-03-13,fay@example.com,US,64,USD
A1033,"Mar 13, 2026",gus@example.it,italy,"€ 72,40",
A1034,2026-03-14,hana@example.com,usa,500,USD
A1035,14/03/2026,ivan@example.de,DE,19.9,EUR
A1036,2026-03-14,jade@example.com,US,"$88.00",USD
A1037,2026-03-15,kai@example.au,AU,140,USD
A1038,2026-03-15,lena@example.es,Spain,33,EUR
A1039,Mar 15 2026,mo@example.com,US,1200,USD`,

  // Tidy rows; some share order_ids with the messy sample, so loading both shows updates.
  clean: `order_id,date,customer_email,country,amount,currency
A1001,2026-03-04,ana.silva@example.com,US,1204.50,USD
A1002,2026-03-04,ben.okafor@example.com,US,95.00,USD
A1003,2026-03-04,chloe@example.de,DE,1250.00,EUR
A1040,2026-03-16,nia@example.com,US,72.00,USD
A1041,2026-03-16,omar@example.co.uk,GB,310.00,GBP
A1042,2026-03-16,pia@example.de,DE,48.90,EUR
A1043,2026-03-17,raj@example.ca,CA,615.00,CAD
A1044,2026-03-17,sara@example.fr,FR,129.00,EUR
A1045,2026-03-17,tom@example.com,US,2400.00,USD
A1046,2026-03-18,uma@example.jp,JP,9800,JPY
A1047,2026-03-18,vic@example.nl,NL,55.00,EUR
A1048,2026-03-18,wen@example.com,US,18.25,USD
A1049,2026-03-19,xia@example.es,ES,840.00,EUR
A1050,2026-03-19,yara@example.it,IT,97.00,EUR
A1051,2026-03-19,zane@example.au,AU,410.00,USD`,

  broken: `id,date,email,country,total
B1,2026-03-04,ana@example.com,US,10
B2,2026-03-05,ben@example.com,US,20
B3,2026-03-06,cy@example.com,DE,30`,
};

// The top-right panel follows this page's own (browser-side) workflow.
let current = null;
Workflow.events.step.on('step_running', (step) => {
  current = { name: step.name, badge: badgeFor(step) };
  status(step.name, 'running', current.badge);
});
const note = (text) => current && status(current.name, text, current.badge);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function table(columns, rows, cell = (row, key) => row[key]) {
  const t = el('table', 'data-table');
  const head = el('tr');
  for (const [, label] of columns) head.append(el('th', '', label));
  t.append(head);
  for (const row of rows) {
    const tr = el('tr');
    for (const [key] of columns) tr.append(el('td', `col-${key}`, String(cell(row, key) ?? '')));
    t.append(tr);
  }
  const wrap = el('div', 'table-wrap');
  wrap.append(t);
  return wrap;
}

// --- Rendering a run ---
function renderStages(run) {
  for (const li of document.querySelectorAll('#pipeline li')) {
    const stage = run?.stages?.[li.dataset.stage];
    li.className = stage ? stage.status : '';
    li.title = stage?.ms != null ? `${stage.ms} ms` : '';
  }
}

function renderCounts(run) {
  const c = run.counts;
  const items = [
    ['extracted', c.extracted, ''],
    ['clean', c.clean, 'good'],
    ['rejected', c.rejected, c.rejected ? 'bad' : ''],
    ['inserted', c.inserted, 'good'],
    ['updated', c.updated, 'info'],
    ['unchanged', c.unchanged, ''],
  ];
  $('counts').replaceChildren(...items.map(([label, value, kind]) => {
    const span = el('span', kind);
    span.append(el('b', '', value), ` ${label}`);
    return span;
  }));
  if (run.gate) {
    const span = el('span', run.gate.passed ? 'good' : 'bad');
    span.append(el('b', '', `${run.gate.rate}%`), ` rejected (gate ${run.gate.limit}%)`);
    $('counts').append(span);
  }
  if (run.summary) {
    const span = el('span', 'good');
    span.append(el('b', '', usd(run.summary.revenue_usd)), ' revenue');
    $('counts').append(span);
  }
}

function renderTabs(run) {
  if (run.profile) {
    $('tab-profile').replaceChildren(table(
      [['column', 'column'], ['filled', 'filled'], ['empty', 'empty'], ['distinct', 'distinct'], ['samples', 'samples']],
      run.profile,
      (row, key) => key === 'samples' ? row.samples.join(' · ') : row[key],
    ));
  }

  $('reject-count').textContent = run.counts.rejected;
  if (run.rejects.length) {
    $('tab-rejects').replaceChildren(table([['line', 'line'], ['order_id', 'order'], ['reason', 'reason']], run.rejects));
  } else if (run.stages.transform.status === 'done') {
    $('tab-rejects').replaceChildren(el('p', 'empty', 'No rows rejected.'));
  }

  if (run.loaded_sample.length) {
    $('tab-loaded').replaceChildren(
      table(
        [['order_id', 'order'], ['date', 'date'], ['email', 'email'], ['country', 'cc'], ['amount', 'amount'], ['currency', 'cur'], ['amount_usd', 'USD']],
        run.loaded_sample,
      ),
      el('p', 'table-note', `First ${run.loaded_sample.length} of ${run.counts.clean} clean rows.`),
    );
  }

  if (run.chunks.length) {
    const list = el('ol', 'chunks');
    for (const chunk of run.chunks) {
      const li = el('li', `chunk ${chunk.state}`);
      li.append(el('span', 'chunk-name', `chunk ${chunk.n}`), el('span', 'chunk-rows', `${chunk.rows} rows`));
      const attempts = el('span', 'attempts');
      for (let i = 0; i < chunk.attempts; i++) {
        const failed = i < chunk.errors.length;
        const pill = el('span', `attempt ${failed ? 'bad' : chunk.state === 'done' ? 'good' : 'busy'}`, failed ? '✕' : chunk.state === 'done' ? '✓' : '…');
        pill.title = failed ? chunk.errors[i] : `attempt ${i + 1}`;
        attempts.append(pill);
      }
      li.append(attempts);
      li.append(el('span', 'chunk-detail', chunk.state === 'done'
        ? `+${chunk.inserted} ~${chunk.updated} =${chunk.unchanged}`
        : chunk.state === 'failed' ? chunk.errors.at(-1) : chunk.state));
      list.append(li);
    }
    $('tab-chunks').replaceChildren(list);
  }
}

function renderRun(run) {
  renderStages(run);
  renderCounts(run);
  renderTabs(run);
  $('run-note').textContent = `run ${run.id} · ${run.status}${run.finished_at ? ` · ${((run.finished_at - run.created_at) / 1000).toFixed(1)} s` : ''}`;
  $('run-error').hidden = !run.error;
  $('run-error').textContent = run.error ?? '';
}

// --- Warehouse ---
async function refreshWarehouse() {
  const data = await api('GET', '/api/etl/warehouse', null, false);
  const totals = $('warehouse-totals');
  totals.replaceChildren();
  for (const [value, label] of [[data.rows.toLocaleString('en-US'), `rows (cap ${data.cap})`], [usd(data.revenue_usd), 'revenue']]) {
    const span = el('span');
    span.append(el('b', '', value), ` ${label}`);
    totals.append(span);
  }

  const entries = Object.entries(data.by_country).sort((a, b) => b[1] - a[1]);
  const top = Math.max(1, ...entries.map(([, v]) => v));
  $('bars').replaceChildren(...entries.map(([code, value]) => {
    const row = el('div', 'bar-row');
    const bar = el('span', 'bar');
    const fill = el('span');
    fill.style.width = `${Math.max(2, (value / top) * 100)}%`;
    bar.append(fill);
    row.append(el('span', 'bar-label', code), bar, el('span', 'bar-value', usd(value)));
    return row;
  }));
  if (!entries.length) $('bars').replaceChildren(el('p', 'empty', 'The warehouse is empty.'));

  const recent = $('recent');
  recent.replaceChildren();
  if (data.recent.length) {
    const head = el('tr');
    for (const label of ['order', 'date', 'cc', 'USD', 'run']) head.append(el('th', '', label));
    recent.append(head);
    for (const row of data.recent) {
      const tr = el('tr');
      for (const value of [row.order_id, row.date, row.country, usd(row.amount_usd), row.run_id]) tr.append(el('td', '', value));
      recent.append(tr);
    }
  }
}

async function api(method, url, body, show = true) {
  if (show) requestEl.textContent = `${method} ${url}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (show) requestEl.textContent = `${method} ${url} → ${res.status}`;
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// --- Client-side workflow: read input, POST, poll, render ---
let draft = null;
let run_id = null;
let run = null;
let runs = 0;

const client = new Workflow({
  name: 'etl-client',
  exit_on_error: true,
  steps: [
    new Step({
      name: 'read-input',
      callable: async () => {
        draft = { csv: csvEl.value, threshold: Number(thresholdEl.value), flaky: flakyEl.checked };
        if (!draft.csv.trim()) throw new Error('Paste some CSV first.');
        const lines = draft.csv.trim().split('\n').length - 1;
        note(`${lines} data lines · gate ${draft.threshold}%${draft.flaky ? ' · flaky' : ''}`);
      },
    }),
    new Step({
      name: 'post-run',
      callable: async () => {
        ({ id: run_id } = await api('POST', '/api/etl/runs', draft));
        note(`POST /api/etl/runs → 202 run ${run_id}`);
      },
    }),
    new LoopStep({
      name: 'poll-run',
      loop_type: 'while',
      conditional: { subject: () => run?.status ?? 'running', operator: '===', value: 'running' },
      max_iterations: 600,
      max_timeout_ms: 3 * 60 * 1000,
      callable: async function () {
        run = await api('GET', `/api/etl/runs/${run_id}`);
        renderRun(run);
        note(`poll ${this.results.length + 1}: ${run.stage ?? 'queued'} (${run.status})`);
        if (run.status === 'running') await sleep(350);
      },
    }),
    new Step({
      name: 'render-report',
      callable: async () => {
        await refreshWarehouse();
        if (run.status === 'failed') throw new Error(run.error);
        const c = run.counts;
        note(`${c.inserted} inserted · ${c.updated} updated · ${c.unchanged} unchanged`);
      },
    }),
  ],
});

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  run = null;
  renderStages(null);
  $('run-error').hidden = true;
  $('counts').replaceChildren();
  try {
    await client.execute();
    if (client.status === 'failed') {
      const error = client.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message ?? 'failed';
      if (!run) {
        $('run-error').textContent = error;
        $('run-error').hidden = false;
      }
      status(client.name, `failed — ${error}`, 'Workflow › failed');
    } else {
      status(client.name, `complete — run ${run_id} loaded`, 'Workflow › complete');
    }
    runs += 1;
    $('run-count').textContent = runs;
  } finally {
    runBtn.disabled = false;
  }
});

// --- Controls ---
function loadSample(name) {
  csvEl.value = SAMPLES[name];
  updateRowCount();
}
function updateRowCount() {
  const lines = csvEl.value.trim() ? csvEl.value.trim().split('\n').length - 1 : 0;
  $('row-count').textContent = `${lines} rows · ${csvEl.value.length.toLocaleString('en-US')} chars`;
}

for (const button of document.querySelectorAll('[data-sample]')) {
  button.addEventListener('click', () => loadSample(button.dataset.sample));
}
csvEl.addEventListener('input', updateRowCount);
thresholdEl.addEventListener('input', () => { $('threshold-label').textContent = `${thresholdEl.value}%`; });

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
    for (const body of document.querySelectorAll('.tab-body')) body.hidden = body.id !== `tab-${tab.dataset.tab}`;
  });
}

$('truncate').addEventListener('click', async () => {
  await api('DELETE', '/api/etl/warehouse', null, false);
  refreshWarehouse();
});

// Other visitors' loads change the shared warehouse too.
server.onEvent((m) => {
  if (m.kind === 'workflow' && /complete|failed/.test(m.event)) refreshWarehouse().catch(() => {});
});

loadSample('messy');
refreshWarehouse().catch(() => {});
