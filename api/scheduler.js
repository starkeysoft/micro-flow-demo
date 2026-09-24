// job-scheduler: each job is a micro-flow workflow on the server that waits
// for an absolute time (DelayStep → node-schedule), then runs its task. Jobs
// live in server memory, so they finish even if every tab is closed, and all
// visitors see the same board.
import express from 'express';
import crypto from 'crypto';
import { Workflow, Step, DelayStep, SwitchStep, Case } from '@ronaldroe/micro-flow';
import { track, forget } from './server-status.js';

export const router = express.Router();

const DEMO = 'scheduler';
const MIN_DELAY_S = 5;
const MAX_DELAY_S = 120;
const MAX_WAITING = 30;
const MAX_PRIMES_LIMIT = 20_000_000;
const EXPIRE_MS = 30 * 60 * 1000;

const jobs = new Map(); // id → job

// --- Tasks (run on the server when a job's time comes) ---
function countPrimes(limit) {
  const composite = new Uint8Array(limit);
  let count = 0;
  for (let n = 2; n < limit; n++) {
    if (composite[n]) continue;
    count++;
    for (let m = n * n; m < limit; m += n) composite[m] = 1;
  }
  return count;
}

const TASKS = {
  deliver: (job) => ({
    text: `“${job.message}”`,
    detail: `delivered at ${new Date().toLocaleTimeString('en-GB')} server time`,
  }),
  dice: () => {
    const rolls = Array.from({ length: 3 }, () => 1 + crypto.randomInt(6));
    return { text: `${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}`, detail: '3d6 rolled on the server' };
  },
  primes: (job) => {
    const started = performance.now();
    const count = countPrimes(job.limit);
    return {
      text: `${count.toLocaleString('en-US')} primes`,
      detail: `below ${job.limit.toLocaleString('en-US')}, counted in ${Math.round(performance.now() - started)} ms`,
    };
  },
};

function buildWorkflow(job) {
  const runTask = (name) => async () => {
    job.status = 'running';
    job.started_at = Date.now();
    job.result = TASKS[name](job);
  };

  const wait = new DelayStep({ name: 'wait-until', delay_type: 'absolute', absolute_timestamp: new Date(job.run_at) });
  wait.max_timeout_ms = (MAX_DELAY_S + 30) * 1000; // longer than the longest wait

  return new Workflow({
    name: `scheduler:${job.id}`,
    exit_on_error: true,
    steps: [
      new Step({ name: 'accept', callable: async () => { job.status = 'waiting'; } }),
      wait,
      new SwitchStep({
        name: 'run-task',
        subject: () => job.task,
        cases: Object.keys(TASKS).map((name) => new Case({
          name,
          conditional: { operator: '===', value: name },
          callable: runTask(name),
        })),
        default_callable: async () => { throw new Error(`unknown task "${job.task}"`); },
      }),
      new Step({
        name: 'store-result',
        callable: async () => {
          job.status = 'done';
          job.finished_at = Date.now();
        },
      }),
    ],
  });
}

const publicJob = ({ workflow, ...job }) => ({ ...job, server_status: workflow.status });

router.get('/scheduler/jobs', (req, res) => {
  const list = [...jobs.values()].sort((a, b) => a.run_at - b.run_at).map(publicJob);
  res.json({ server_time: Date.now(), jobs: list });
});

router.post('/scheduler/jobs', (req, res) => {
  const { message = '', task = 'deliver', delay_seconds, limit } = req.body ?? {};
  const delay = Number(delay_seconds);

  if (!TASKS[task]) return res.status(400).json({ error: `Unknown task "${task}".` });
  if (!Number.isFinite(delay) || delay < MIN_DELAY_S || delay > MAX_DELAY_S) {
    return res.status(400).json({ error: `delay_seconds must be ${MIN_DELAY_S}–${MAX_DELAY_S}.` });
  }
  if (task === 'deliver' && !String(message).trim()) return res.status(400).json({ error: 'Write a message to deliver.' });
  const waiting = [...jobs.values()].filter((job) => job.status === 'waiting').length;
  if (waiting >= MAX_WAITING) return res.status(429).json({ error: `${MAX_WAITING} jobs are already waiting. Try again later.` });

  const now = Date.now();
  const job = {
    id: crypto.randomUUID().slice(0, 8),
    task,
    message: String(message).slice(0, 120),
    limit: Math.min(MAX_PRIMES_LIMIT, Math.max(1000, Math.floor(Number(limit) || 5_000_000))),
    status: 'scheduled',
    created_at: now,
    run_at: now + Math.round(delay * 1000),
    started_at: null,
    finished_at: null,
    result: null,
    error: null,
  };
  job.workflow = buildWorkflow(job);
  track(job.workflow, DEMO, job.id, { top: true });
  jobs.set(job.id, job);

  // Not awaited: the request returns now and the workflow keeps running on the server.
  job.workflow.execute()
    .then(() => {
      if (job.workflow.status === 'failed') {
        job.status = 'failed';
        job.error = job.workflow.steps.find((s) => s.status === 'failed')?.errors.at(-1)?.message ?? 'failed';
        job.finished_at = Date.now();
      }
    })
    .catch((error) => {
      job.status = 'failed';
      job.error = error.message;
      job.finished_at = Date.now();
    });

  res.status(201).json({ server_time: Date.now(), job: publicJob(job) });
});

router.delete('/scheduler/jobs', (req, res) => {
  let removed = 0;
  if (req.query.finished) {
    for (const [id, job] of jobs) {
      if (job.status === 'done' || job.status === 'failed') {
        forget(job.workflow);
        jobs.delete(id);
        removed++;
      }
    }
  }
  res.json({ removed });
});

// Finished jobs expire after 30 minutes.
setInterval(() => {
  const cutoff = Date.now() - EXPIRE_MS;
  for (const [id, job] of jobs) {
    if (job.finished_at && job.finished_at < cutoff) {
      forget(job.workflow);
      jobs.delete(id);
    }
  }
}, 60 * 1000).unref();
