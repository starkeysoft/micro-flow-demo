// link-checker: the server fetches URLs the browser can't (most sites don't
// allow cross-origin reads). Each POST starts a micro-flow workflow on the
// server; the page polls GET for results as they come in.
import express from 'express';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { Workflow, Step, LoopStep } from '@ronaldroe/micro-flow';
import { track, forget } from './server-status.js';

export const router = express.Router();

const DEMO = 'link-check';
const MAX_URLS = 10;
const MAX_JOBS = 25;
const MAX_RUNNING = 3;
const ATTEMPT_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 5;

const jobs = new Map(); // id → job
let running = 0;

// --- SSRF guard: never fetch loopback, private or link-local addresses ---
function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

class Blocked extends Error {}
class DnsFailure extends Error {}

async function guard(url) {
  const { hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch (error) {
    throw new DnsFailure(error.code ?? error.message);
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Blocked('private address');
}

// One attempt: follow redirects by hand so every hop goes through guard().
async function checkOnce(url) {
  const started = performance.now();
  let current = url;
  let first_status = null;

  for (let hop = 0; ; hop++) {
    await guard(current);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      headers: { 'user-agent': 'micro-flow-demo link checker' },
    });
    await res.body?.cancel();

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
      first_status ??= res.status;
      current = new URL(location, current).href;
      continue;
    }

    return {
      kind: res.status >= 400 ? 'broken' : first_status ? 'redirect' : 'ok',
      status: res.status,
      first_status,
      final_url: current,
      content_type: res.headers.get('content-type')?.split(';')[0] ?? null,
      ms: Math.round(performance.now() - started),
    };
  }
}

function classifyFailure(error) {
  if (error instanceof Blocked) return { kind: 'blocked', error: 'blocked: private address' };
  if (error instanceof DnsFailure) return { kind: 'dns', error: `DNS: ${error.message}` };
  if (error?.name === 'TimeoutError' || /timed out/.test(error?.message)) return { kind: 'timeout', error: 'timed out' };
  return { kind: 'error', error: error?.cause?.code ?? error?.message ?? 'request failed' };
}

function normalize(raw) {
  try {
    const url = new URL(String(raw).trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function buildWorkflow(job) {
  const workflow = new Workflow({
    name: `link-check:${job.id}`,
    exit_on_error: true,
    steps: [
      // 1. Normalize, dedupe and cap the list; one result row per URL.
      new Step({
        name: 'validate',
        callable: async () => {
          const seen = new Set();
          for (const raw of job.input) {
            const url = normalize(raw);
            if (url && seen.has(url)) continue;
            if (url) seen.add(url);
            job.results.push(url
              ? { url, state: 'queued' }
              : { url: String(raw), state: 'done', kind: 'invalid', error: 'not an http(s) URL' });
          }
          job.status = 'checking';
        },
      }),

      // 2. Check each URL with its own Step: one retry, and a timeout per attempt.
      new LoopStep({
        name: 'check-urls',
        loop_type: 'for_each',
        iterable: () => job.results.filter((row) => row.state === 'queued'),
        max_timeout_ms: 5 * 60 * 1000,
        callable: async function () {
          const row = this.current_item;
          row.state = 'checking';

          const check = new Step({
            name: `check-${job.results.indexOf(row) + 1}`,
            max_retries: 1,
            max_timeout_ms: ATTEMPT_TIMEOUT_MS + 1000,
            callable: async () => {
              try {
                return await checkOnce(row.url);
              } catch (error) {
                // Blocked and DNS failures won't change on a retry, so return them as results.
                if (error instanceof Blocked || error instanceof DnsFailure) return classifyFailure(error);
                throw error;
              }
            },
          });
          track(check, DEMO, job.id);
          await check.execute();
          forget(check);

          const outcome = check.status === 'complete' ? check.result : classifyFailure(check.errors.at(-1));
          Object.assign(row, outcome, { state: 'done', attempts: check.retry_count + 1 });
          return row.kind;
        },
      }),

      // 3. Count the results.
      new Step({
        name: 'summarize',
        callable: async () => {
          const summary = { ok: 0, redirect: 0, broken: 0, failed: 0 };
          for (const row of job.results) {
            if (row.kind === 'ok') summary.ok++;
            else if (row.kind === 'redirect') summary.redirect++;
            else if (row.kind === 'broken') summary.broken++;
            else summary.failed++;
          }
          job.summary = summary;
        },
      }),
    ],
  });
  return workflow;
}

router.post('/link-check', (req, res) => {
  const input = req.body?.urls;
  if (!Array.isArray(input) || !input.length) return res.status(400).json({ error: 'Send { urls: [...] } with at least one URL.' });
  if (input.length > MAX_URLS) return res.status(400).json({ error: `At most ${MAX_URLS} URLs per check.` });
  if (running >= MAX_RUNNING) return res.status(429).json({ error: 'The server is busy with other checks. Try again in a few seconds.' });

  const job = {
    id: crypto.randomUUID().slice(0, 8),
    status: 'queued',
    created_at: Date.now(),
    finished_at: null,
    input: input.slice(0, MAX_URLS),
    results: [],
    summary: null,
    error: null,
  };

  const workflow = buildWorkflow(job);
  job.workflow = workflow;
  track(workflow, DEMO, job.id, { top: true });
  jobs.set(job.id, job);

  // Keep only the newest jobs.
  for (const [id, old] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (old.status === 'done' || old.status === 'error') {
      forget(old.workflow);
      jobs.delete(id);
    }
  }

  running++;
  workflow.execute()
    .then(() => {
      job.status = workflow.status === 'failed' ? 'error' : 'done';
      if (workflow.status === 'failed') job.error = workflow.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message ?? 'failed';
    })
    .catch((error) => {
      job.status = 'error';
      job.error = error.message;
    })
    .finally(() => {
      job.finished_at = Date.now();
      running--;
    });

  res.status(202).json({ id: job.id });
});

router.get('/link-check/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job.' });
  const { workflow, input, ...public_job } = job;
  res.json({ ...public_job, server_workflow: workflow.name, server_status: workflow.status });
});
