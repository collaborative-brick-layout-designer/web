// The import queue (docs/model-import.md, "Jobs"). Each upload is a job:
//   queued → analysing → ready (the preview) → queued → converting → done
//   or failed / cancelled at any point.
// Limits, from Admin › Model import: how many steps one person may start
// an hour, how many of one person's steps run at once, how many run on the
// server at once. A person has at most MAX_OPEN_PER_USER jobs open.
//
// Files: each job has its own folder under <data>/import-jobs/<id>/ (in/,
// out/, the request). The folder is deleted when the job is done, failed,
// cancelled or left alone for IDLE_MS; the whole import-jobs folder is
// emptied at start (a crash or restart leaves nothing behind), and a sweep
// every few minutes removes any folder no job owns. Nothing is logged about
// the file.

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../env.js';
import { runConverter } from './converter.js';
import { converterLibraries, jobsDir } from './libraries.js';
import { importSettings } from './settings.js';

export type JobState = 'queued' | 'analysing' | 'ready' | 'converting' | 'done' | 'failed' | 'cancelled';
export type Step = 'analyse' | 'convert';

export interface JobError {
  code: string;
  message: string;
}

export interface Job {
  id: string;
  userId: string;
  fileName: string;
  /** The saved upload, under the job's folder. */
  input: string;
  dir: string;
  state: JobState;
  step: Step;
  createdAt: number;
  updatedAt: number;
  analysis: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: JobError | null;
  /** What to do with the converter's result (convert step). */
  options: Record<string, unknown> | null;
  onConverted: ((job: Job, result: Record<string, unknown>) => Promise<Record<string, unknown> | JobError>) | null;
  abort: AbortController | null;
}

export const MAX_OPEN_PER_USER = 3;
/** A preview nobody acts on, and a finished job's summary, go after this. */
export const IDLE_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;

const jobs = new Map<string, Job>();
const order: string[] = [];
const starts = new Map<string, number[]>();
let sweeper: NodeJS.Timeout | null = null;

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function openJobsOf(userId: string): Job[] {
  return [...jobs.values()].filter((j) => j.userId === userId && !['done', 'failed', 'cancelled'].includes(j.state));
}

/** Count a step against the person's hourly allowance; false when it's used up. */
export async function takeTurn(userId: string, now = Date.now()): Promise<boolean> {
  const { limits } = await importSettings();
  const recent = (starts.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= limits.perHour) {
    starts.set(userId, recent);
    return false;
  }
  recent.push(now);
  starts.set(userId, recent);
  return true;
}

/** When the person's next turn comes, in seconds (for Retry-After). */
export function secondsToNextTurn(userId: string, now = Date.now()): number {
  const recent = (starts.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  return recent.length ? Math.max(1, Math.ceil((recent[0]! + 3_600_000 - now) / 1000)) : 1;
}

/** A job for an upload, its folder made. The caller saves the file to `job.input`. */
export async function newJob(userId: string, safeName: string): Promise<Job> {
  const id = randomUUID();
  const dir = join(jobsDir(), id);
  await mkdir(join(dir, 'in'), { recursive: true });
  await mkdir(join(dir, 'out'), { recursive: true });
  const now = Date.now();
  const job: Job = {
    id,
    userId,
    fileName: safeName,
    input: join(dir, 'in', safeName),
    dir,
    state: 'queued',
    step: 'analyse',
    createdAt: now,
    updatedAt: now,
    analysis: null,
    result: null,
    error: null,
    options: null,
    onConverted: null,
    abort: null,
  };
  jobs.set(id, job);
  ensureSweeper();
  return job;
}

/** Queue the job's next step. */
export function enqueue(job: Job, step: Step): void {
  job.step = step;
  job.state = 'queued';
  job.updatedAt = Date.now();
  order.push(job.id);
  void pump();
}

/** Where the job is in the line (1 = next), or 0 when it isn't waiting. */
export function positionOf(job: Job): number {
  if (job.state !== 'queued') return 0;
  return order.indexOf(job.id) + 1;
}

function running(): Job[] {
  return [...jobs.values()].filter((j) => j.state === 'analysing' || j.state === 'converting');
}

let pumping = false;
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const { limits } = await importSettings();
    for (;;) {
      const now = running();
      if (now.length >= limits.atOnce) return;
      const next = order.find((id) => {
        const j = jobs.get(id);
        return j && j.state === 'queued' && now.filter((r) => r.userId === j.userId).length < limits.perUserAtOnce;
      });
      if (!next) return;
      order.splice(order.indexOf(next), 1);
      const job = jobs.get(next)!;
      void runStep(job);
    }
  } finally {
    pumping = false;
  }
}

async function runStep(job: Job): Promise<void> {
  job.state = job.step === 'analyse' ? 'analysing' : 'converting';
  job.updatedAt = Date.now();
  job.abort = new AbortController();
  try {
    const { limits } = await importSettings();
    const out = join(job.dir, 'out');
    if (job.step === 'convert') {
      // A fresh out/ for the result; the preview is no longer needed.
      await rm(out, { recursive: true, force: true });
      await mkdir(out, { recursive: true });
    }
    const request = {
      command: job.step,
      input: job.input,
      outDir: out,
      libraries: { parts: [env.partsDir], ...(await converterLibraries()) },
      limits: { maxInputBytes: limits.maxUploadMb * 1024 * 1024, maxEntries: 5000, maxUncompressedBytes: 768 * 1024 * 1024, maxRatio: 100 },
      ...(job.step === 'convert' ? { options: job.options ?? {} } : {}),
    };
    const reqPath = join(job.dir, 'request.json');
    await writeFile(reqPath, JSON.stringify(request));
    const outcome = await runConverter(reqPath, job.dir, { timeoutSeconds: limits.timeoutSeconds, memoryMb: limits.memoryMb }, job.abort.signal);
    if ((job.state as JobState) === 'cancelled') return;
    if (outcome.kind === 'timeout') return fail(job, { code: 'timeout', message: `This file took longer than ${limits.timeoutSeconds} seconds, so it was stopped.` });
    if (outcome.kind === 'cancelled') return;
    if (outcome.kind === 'crashed') return fail(job, { code: 'crashed', message: 'The import stopped part way (the file may be too big or damaged).' });
    const r = outcome.result;
    if (r.ok !== true) return fail(job, { code: String(r.error ?? 'failed'), message: String(r.message ?? 'The file couldn’t be imported.') });
    if (job.step === 'analyse') {
      job.analysis = r;
      job.state = 'ready';
      job.updatedAt = Date.now();
      return;
    }
    const applied = job.onConverted ? await job.onConverted(job, r) : r;
    if ('code' in applied && 'message' in applied && typeof applied.code === 'string') return fail(job, applied as JobError);
    // The files go first: "done" means nothing of the upload is left.
    await removeFiles(job);
    job.result = applied as Record<string, unknown>;
    job.state = 'done';
    job.updatedAt = Date.now();
  } catch {
    if ((job.state as JobState) !== 'cancelled') await fail(job, { code: 'failed', message: 'The import failed on the server.' });
  } finally {
    job.abort = null;
    void pump();
  }
}

async function fail(job: Job, error: JobError): Promise<void> {
  await removeFiles(job);
  job.state = 'failed';
  job.error = error;
  job.updatedAt = Date.now();
}

async function removeFiles(job: Job): Promise<void> {
  await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Stop and forget the job, and delete its files. */
export async function cancelJob(job: Job): Promise<void> {
  const wasRunning = job.state === 'analysing' || job.state === 'converting';
  if (!['done', 'failed'].includes(job.state)) job.state = 'cancelled';
  job.updatedAt = Date.now();
  const at = order.indexOf(job.id);
  if (at >= 0) order.splice(at, 1);
  if (wasRunning) job.abort?.abort();
  await removeFiles(job);
  jobs.delete(job.id);
  void pump();
}

/** Drop finished and idle jobs, and any folder no job owns. */
export async function sweep(now = Date.now()): Promise<void> {
  for (const job of [...jobs.values()]) {
    const idle = now - job.updatedAt > IDLE_MS;
    if (idle && job.state !== 'analysing' && job.state !== 'converting') {
      await removeFiles(job);
      jobs.delete(job.id);
      const at = order.indexOf(job.id);
      if (at >= 0) order.splice(at, 1);
    }
  }
  let names: string[];
  try {
    names = await readdir(jobsDir());
  } catch {
    return;
  }
  for (const n of names) {
    const j = jobs.get(n);
    if (!j || j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') await rm(join(jobsDir(), n), { recursive: true, force: true }).catch(() => undefined);
  }
}

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => void sweep(), SWEEP_MS);
  sweeper.unref();
}

/** At start: whatever a crash or restart left behind goes. */
export async function clearJobsAtStart(): Promise<void> {
  await rm(jobsDir(), { recursive: true, force: true }).catch(() => undefined);
}

/** Tests. */
export function resetJobs(): void {
  for (const j of jobs.values()) j.abort?.abort();
  jobs.clear();
  order.length = 0;
  starts.clear();
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

export function jobCounts(): { queued: number; running: number; open: number } {
  const all = [...jobs.values()];
  return {
    queued: all.filter((j) => j.state === 'queued').length,
    running: running().length,
    open: all.filter((j) => !['done', 'failed', 'cancelled'].includes(j.state)).length,
  };
}
