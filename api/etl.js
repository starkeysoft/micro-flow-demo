// etl-pipeline: a batch ETL job on the server. Each POST starts a micro-flow
// workflow that extracts a CSV, profiles it, cleans it in batches (generator
// loop), checks a quality gate (ConditionalStep), then upserts it into a
// shared in-memory "warehouse" in chunks that retry on flaky writes.
import express from 'express';
import crypto from 'crypto';
import { Workflow, Step, LoopStep, ConditionalStep } from '@ronaldroe/micro-flow';
import { track, forget } from './server-status.js';

export const router = express.Router();

const DEMO = 'etl';
const MAX_CSV_CHARS = 24_000;
const MAX_ROWS = 400;
const MAX_RUNS = 20;
const MAX_RUNNING = 2;
const BATCH_SIZE = 50;
const CHUNK_SIZE = 20;
const WAREHOUSE_CAP = 2000;
const FLAKY_FAIL_RATE = 0.35;

const REQUIRED = ['order_id', 'date', 'customer_email', 'country', 'amount', 'currency'];
const STAGES = { extract: 'extract', profile: 'profile', transform: 'transform', 'quality-gate': 'gate', load: 'load', report: 'report' };
const USD_RATES = { USD: 1, EUR: 1.08, GBP: 1.27, JPY: 0.0067, CAD: 0.73 };
const SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const COUNTRIES = {
  US: ['us', 'usa', 'united states', 'united states of america'],
  CA: ['ca', 'canada'],
  GB: ['gb', 'uk', 'united kingdom', 'great britain', 'england'],
  DE: ['de', 'germany', 'deutschland'],
  FR: ['fr', 'france'],
  ES: ['es', 'spain', 'españa'],
  IT: ['it', 'italy'],
  NL: ['nl', 'netherlands', 'holland'],
  JP: ['jp', 'japan'],
  AU: ['au', 'australia'],
};
const COUNTRY_LOOKUP = new Map(Object.entries(COUNTRIES).flatMap(([code, names]) => names.map((n) => [n, code])));
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const runs = new Map();       // id → run
const by_workflow = new Map(); // workflow id → run (for stage events)
const warehouse = new Map();   // order_id → row (insertion order = least recently written first)
let running = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

// --- Extract: an RFC 4180-style CSV parser (quoted fields, "" escapes, CRLF) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// --- Transform helpers ---
function isoDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function parseDate(raw) {
  const s = raw.trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) return isoDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/))) return isoDate(+m[3], +m[2], +m[1]); // DD/MM/YYYY
  if ((m = s.match(/^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/i))) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    return month ? isoDate(+m[3], month, +m[2]) : null;
  }
  return null;
}

// "$1,204.50", "1.204,50", "89", "€ 12,5" → { value, symbol_currency }
function parseAmount(raw) {
  let s = raw.trim();
  let symbol_currency = null;
  for (const [symbol, code] of Object.entries(SYMBOLS)) {
    if (s.includes(symbol)) { symbol_currency = code; s = s.replace(symbol, ''); }
  }
  s = s.replace(/\s/g, '');
  if (!/^-?[\d.,]+$/.test(s)) return { value: null, symbol_currency };
  const last_dot = s.lastIndexOf('.');
  const last_comma = s.lastIndexOf(',');
  if (last_dot >= 0 && last_comma >= 0) {
    // Whichever separator comes last is the decimal point.
    s = last_comma > last_dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (last_comma >= 0) {
    // "1,204" is thousands; "12,5" / "12,50" is a decimal comma.
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const value = Number(s);
  return { value: Number.isFinite(value) ? value : null, symbol_currency };
}

// One CSV record → { row } or { reason }.
function cleanRecord(record) {
  const order_id = record.order_id.trim().toUpperCase();
  if (!order_id) return { reason: 'missing order_id' };

  const date = parseDate(record.date);
  if (!date) return { reason: `unparseable date "${record.date.trim()}"` };

  const email = record.customer_email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return { reason: `invalid email "${record.customer_email.trim()}"` };

  const country = COUNTRY_LOOKUP.get(record.country.trim().toLowerCase().replace(/\./g, ''));
  if (!country) return { reason: `unknown country "${record.country.trim()}"` };

  if (!record.amount.trim()) return { reason: 'missing amount' };
  const { value, symbol_currency } = parseAmount(record.amount);
  if (value === null) return { reason: `unparseable amount "${record.amount.trim()}"` };
  if (value <= 0) return { reason: `amount must be positive (${value})` };

  const currency = record.currency.trim().toUpperCase() || symbol_currency;
  if (!currency) return { reason: 'missing currency' };
  if (!USD_RATES[currency]) return { reason: `unknown currency "${currency}"` };

  return {
    row: {
      order_id,
      date,
      email,
      country,
      amount: Math.round(value * 100) / 100,
      currency,
      amount_usd: Math.round(value * USD_RATES[currency] * 100) / 100,
    },
  };
}

// --- Load: one transactional chunk write ---
function upsertChunk(rows) {
  const counts = { inserted: 0, updated: 0, unchanged: 0 };
  const writes = [];
  for (const row of rows) {
    const existing = warehouse.get(row.order_id);
    const { loaded_at, run_id, ...old } = existing ?? {};
    if (!existing) counts.inserted++;
    else if (JSON.stringify(old) === JSON.stringify(row)) { counts.unchanged++; continue; }
    else counts.updated++;
    writes.push(row);
  }
  return { counts, writes };
}

function commit(writes, run_id) {
  const now = Date.now();
  for (const row of writes) {
    warehouse.delete(row.order_id); // re-insert so it moves to the "newest" end
    warehouse.set(row.order_id, { ...row, loaded_at: now, run_id });
  }
  while (warehouse.size > WAREHOUSE_CAP) warehouse.delete(warehouse.keys().next().value);
}

function buildWorkflow(run) {
  let records = [];

  return new Workflow({
    name: `etl:${run.id}`,
    exit_on_error: true,
    steps: [
      // 1. Extract: parse the CSV and check its header.
      new Step({
        name: 'extract',
        callable: async () => {
          await jitter(300, 600);
          const table = parseCsv(run.csv);
          if (!table.length) throw new Error('extract: the CSV is empty');
          const header = table[0].map((h) => h.trim().toLowerCase());
          const missing = REQUIRED.filter((c) => !header.includes(c));
          if (missing.length) throw new Error(`extract: missing required column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);
          const body = table.slice(1);
          if (body.length > MAX_ROWS) throw new Error(`extract: ${body.length} rows (limit ${MAX_ROWS})`);
          records = body.map((fields, i) => {
            const record = { line: i + 2 };
            header.forEach((name, c) => { record[name] = fields[c] ?? ''; });
            for (const name of REQUIRED) record[name] ??= '';
            return record;
          });
          run.counts.extracted = records.length;
          run.columns = header;
          return { rows: records.length };
        },
      }),

      // 2. Profile: what does the raw data look like?
      new Step({
        name: 'profile',
        callable: async () => {
          await jitter(300, 500);
          run.profile = run.columns.map((name) => {
            const values = records.map((r) => (r[name] ?? '').trim());
            const filled = values.filter(Boolean);
            const distinct = new Set(filled);
            return { column: name, filled: filled.length, empty: values.length - filled.length, distinct: distinct.size, samples: [...distinct].slice(0, 3) };
          });
          return { columns: run.profile.length };
        },
      }),

      // 3. Transform: clean, validate and dedupe one batch per generator pass.
      new LoopStep({
        name: 'transform',
        loop_type: 'generator',
        max_timeout_ms: 60_000,
        callable: async function* () {
          const kept = new Map(); // order_id → row (later lines win)
          for (let start = 0; start < records.length; start += BATCH_SIZE) {
            await jitter(300, 600);
            const batch = records.slice(start, start + BATCH_SIZE);
            let accepted = 0;
            let rejected = 0;
            for (const record of batch) {
              const { row, reason } = cleanRecord(record);
              if (!row) {
                run.rejects.push({ line: record.line, order_id: record.order_id.trim(), reason });
                rejected++;
                continue;
              }
              const earlier = kept.get(row.order_id);
              if (earlier) {
                run.rejects.push({ line: earlier.line, order_id: row.order_id, reason: `duplicate order_id, superseded by line ${record.line}` });
                rejected++;
              }
              kept.set(row.order_id, { ...row, line: record.line });
              accepted++;
            }
            run.counts.transformed = Math.min(records.length, start + BATCH_SIZE);
            run.counts.rejected = run.rejects.length;
            run.batches.push({ n: run.batches.length + 1, rows: batch.length, accepted, rejected });
            // Yield a small summary, not the rows: loop results end up in event payloads.
            yield { batch: run.batches.length, accepted, rejected };
          }
          run.clean = [...kept.values()].map(({ line, ...row }) => row);
          run.counts.clean = run.clean.length;
          run.rejects.sort((a, b) => a.line - b.line);
        },
      }),

      // 4. Quality gate: refuse to load a file that is mostly junk.
      new ConditionalStep({
        name: 'quality-gate',
        conditional: {
          subject: () => run.counts.extracted ? Math.round((run.rejects.length / run.counts.extracted) * 100) : 0,
          operator: '<=',
          value: () => run.threshold,
        },
        true_callable: async () => {
          await jitter(200, 400);
          run.gate = { passed: true, rate: rejectRate(run), limit: run.threshold };
        },
        false_callable: async () => {
          await jitter(200, 400);
          run.gate = { passed: false, rate: rejectRate(run), limit: run.threshold };
          throw new Error(`quality gate: ${run.gate.rate}% rejected (limit ${run.threshold}%), nothing loaded`);
        },
      }),

      // 5. Load: upsert in chunks; each chunk is its own Step with retries.
      new LoopStep({
        name: 'load',
        loop_type: 'for_each',
        max_timeout_ms: 120_000,
        iterable: () => {
          const chunks = [];
          for (let i = 0; i < run.clean.length; i += CHUNK_SIZE) chunks.push(run.clean.slice(i, i + CHUNK_SIZE));
          run.chunks = chunks.map((rows, i) => ({ n: i + 1, rows: rows.length, state: 'queued', attempts: 0, errors: [] }));
          return chunks.map((rows, i) => ({ rows, info: run.chunks[i] }));
        },
        callable: async function () {
          const { rows, info } = this.current_item;
          info.state = 'writing';

          const write = new Step({
            name: `write-chunk-${info.n}`,
            max_retries: 3,
            max_timeout_ms: 5000,
            callable: async () => {
              info.attempts++;
              if (info.attempts > 1) await sleep(150 * 2 ** (info.attempts - 2)); // backoff
              await jitter(150, 400);
              if (run.flaky && Math.random() < FLAKY_FAIL_RATE) {
                const error = ['connection reset by warehouse', 'lock wait timeout', 'warehouse 503'][Math.floor(Math.random() * 3)];
                info.errors.push(error);
                throw new Error(error);
              }
              // Transactional: compute every write first, then apply them together.
              const { counts, writes } = upsertChunk(rows);
              commit(writes, run.id);
              return counts;
            },
          });
          track(write, DEMO, run.id);
          await write.execute();
          forget(write);

          if (write.status !== 'complete') {
            info.state = 'failed';
            throw new Error(`load: chunk ${info.n} failed after ${info.attempts} attempts (${info.errors.at(-1)}); ${info.n - 1} chunk(s) committed`);
          }
          const counts = write.result;
          Object.assign(info, counts, { state: 'done' });
          for (const key of ['inserted', 'updated', 'unchanged']) run.counts[key] += counts[key];
          return { chunk: info.n, attempts: info.attempts };
        },
      }),

      // 6. Report.
      new Step({
        name: 'report',
        callable: async () => {
          await jitter(200, 400);
          const by_country = {};
          for (const row of run.clean) by_country[row.country] = Math.round(((by_country[row.country] ?? 0) + row.amount_usd) * 100) / 100;
          run.summary = {
            revenue_usd: Math.round(run.clean.reduce((sum, row) => sum + row.amount_usd, 0) * 100) / 100,
            by_country,
            retries: run.chunks.reduce((sum, c) => sum + c.attempts - 1, 0),
          };
          return { rows: run.clean.length };
        },
      }),
    ],
  });
}

function rejectRate(run) {
  return run.counts.extracted ? Math.round((run.rejects.length / run.counts.extracted) * 100) : 0;
}

// Stage lights come from the workflow's own step events.
for (const [event_name, state] of [['step_running', 'running'], ['step_complete', 'done'], ['step_failed', 'failed']]) {
  Workflow.events.step.on(event_name, (detail) => {
    const run = by_workflow.get(detail?.parent_workflow_id);
    const stage = STAGES[detail?.name];
    if (!run || !stage) return;
    run.stages[stage] = { status: state, ms: detail.timing?.execution_time_ms ?? null };
    if (state === 'running') run.stage = stage;
  });
}

function drop(run) {
  forget(run.workflow);
  by_workflow.delete(run.workflow.id);
  runs.delete(run.id);
}

router.post('/etl/runs', (req, res) => {
  const { csv, threshold = 20, flaky = false } = req.body ?? {};
  if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'Send { csv: "..." } with some CSV.' });
  if (csv.length > MAX_CSV_CHARS) return res.status(400).json({ error: `CSV is limited to ${MAX_CSV_CHARS.toLocaleString('en-US')} characters.` });
  if (running >= MAX_RUNNING) return res.status(429).json({ error: 'Two ETL runs are already in progress. Try again in a few seconds.' });

  const run = {
    id: crypto.randomUUID().slice(0, 8),
    status: 'running',
    stage: null,
    stages: Object.fromEntries(Object.values(STAGES).map((s) => [s, { status: 'pending', ms: null }])),
    created_at: Date.now(),
    finished_at: null,
    csv,
    threshold: Math.min(100, Math.max(0, Math.round(Number(threshold) || 0))),
    flaky: Boolean(flaky),
    columns: [],
    profile: null,
    counts: { extracted: 0, transformed: 0, rejected: 0, clean: 0, inserted: 0, updated: 0, unchanged: 0 },
    batches: [],
    rejects: [],
    clean: [],
    gate: null,
    chunks: [],
    summary: null,
    error: null,
  };
  run.workflow = buildWorkflow(run);
  track(run.workflow, DEMO, run.id, { top: true });
  by_workflow.set(run.workflow.id, run);
  runs.set(run.id, run);

  for (const old of runs.values()) {
    if (runs.size <= MAX_RUNS) break;
    if (old.status !== 'running') drop(old);
  }

  running++;
  run.workflow.execute()
    .then(() => {
      if (run.workflow.status === 'failed') {
        run.status = 'failed';
        run.error = run.workflow.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message ?? 'failed';
      } else {
        run.status = 'done';
      }
    })
    .catch((error) => {
      run.status = 'failed';
      run.error = error.message;
    })
    .finally(() => {
      run.finished_at = Date.now();
      run.csv = null; // the input isn't needed any more
      running--;
    });

  res.status(202).json({ id: run.id });
});

router.get('/etl/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'No such run.' });
  const { workflow, csv, clean, rejects, ...rest } = run;
  res.json({
    ...rest,
    rejects: rejects.slice(0, 50),
    loaded_sample: run.status === 'done' ? clean.slice(0, 15) : [],
    server_workflow: workflow.name,
    server_status: workflow.status,
  });
});

router.get('/etl/warehouse', (req, res) => {
  const by_country = {};
  let revenue_usd = 0;
  for (const row of warehouse.values()) {
    by_country[row.country] = (by_country[row.country] ?? 0) + row.amount_usd;
    revenue_usd += row.amount_usd;
  }
  for (const code of Object.keys(by_country)) by_country[code] = Math.round(by_country[code] * 100) / 100;
  res.json({
    rows: warehouse.size,
    cap: WAREHOUSE_CAP,
    revenue_usd: Math.round(revenue_usd * 100) / 100,
    by_country,
    recent: [...warehouse.values()].slice(-10).reverse(),
  });
});

router.delete('/etl/warehouse', (req, res) => {
  const removed = warehouse.size;
  warehouse.clear();
  res.json({ removed });
});
