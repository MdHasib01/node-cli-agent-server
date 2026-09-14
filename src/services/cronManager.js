import cron from 'node-cron';
import { CronJob } from '../models/CronJob.js';
import { CronRun } from '../models/CronRun.js';
import { HttpError } from '../utils/httpError.js';
import { broadcast, notify } from './notifications.js';

/**
 * Cron jobs are defined in code (key, name, handler) and their schedule / enabled
 * flag / run history live in MongoDB, so they can be managed from the dashboard.
 * A handler returns `{ summary, details }`; a thrown error marks the run failed.
 */
const definitions = new Map();
const tasks = new Map();
// key -> promise of the run in progress; a second trigger joins it instead of overlapping.
const running = new Map();

export function defineJob(definition) {
  definitions.set(definition.key, definition);
}

export async function startCronJobs() {
  for (const definition of definitions.values()) {
    const job = await CronJob.findOneAndUpdate(
      { key: definition.key },
      { $setOnInsert: { key: definition.key, schedule: definition.defaultSchedule, enabled: true } },
      { upsert: true, returnDocument: 'after' },
    );
    if (!cron.validate(job.schedule)) {
      console.warn(`[cron ${definition.key}] invalid schedule "${job.schedule}", using "${definition.defaultSchedule}"`);
      job.schedule = definition.defaultSchedule;
      await job.save();
    }
    if (!job.enabled) continue;
    schedule(definition.key, job.schedule);
    if (definition.runOnStart) execute(definition.key, 'startup').catch(() => {});
  }
}

export function stopCronJobs() {
  for (const task of tasks.values()) task.destroy();
  tasks.clear();
}

export async function listCronJobs() {
  const jobs = await CronJob.find({ key: { $in: [...definitions.keys()] } });
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  return [...definitions.values()].map((definition) => {
    const job = byKey.get(definition.key);
    return {
      ...(job?.toJSON() ?? { key: definition.key, schedule: definition.defaultSchedule, enabled: false }),
      name: definition.name,
      description: definition.description,
      defaultSchedule: definition.defaultSchedule,
      running: running.has(definition.key),
      nextRunAt: job?.enabled ? tasks.get(definition.key)?.getNextRun() ?? null : null,
    };
  });
}

export async function getCronJob(key) {
  assertDefined(key);
  return (await listCronJobs()).find((job) => job.key === key);
}

export async function listRuns(key, limit) {
  assertDefined(key);
  return CronRun.find({ job: key }).sort({ startedAt: -1 }).limit(limit).populate('triggeredBy', 'name');
}

/** Runs a job right away (or joins the run already in progress) and resolves with the run. */
export function runNow(key, user) {
  assertDefined(key);
  return execute(key, 'manual', user?._id ?? null);
}

export async function updateCronJob(key, { schedule: expression, enabled }) {
  assertDefined(key);
  const job = await CronJob.findOne({ key });
  if (!job) throw new HttpError(404, 'Cron job not found');

  if (expression !== undefined) {
    if (typeof expression !== 'string' || !cron.validate(expression.trim())) {
      throw new HttpError(400, '"schedule" must be a valid cron expression, e.g. "*/5 * * * *"');
    }
    job.schedule = expression.trim();
  }
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false');
    job.enabled = enabled;
  }
  await job.save();

  if (job.enabled) schedule(key, job.schedule);
  else unschedule(key);
  broadcast('cron', { key }, { audience: 'admins' });
  return getCronJob(key);
}

function schedule(key, expression) {
  unschedule(key);
  const task = cron.schedule(expression, () => execute(key, 'scheduled').catch(() => {}), { name: key, noOverlap: true });
  tasks.set(key, task);
}

function unschedule(key) {
  tasks.get(key)?.destroy();
  tasks.delete(key);
}

function execute(key, trigger, triggeredBy = null) {
  if (running.has(key)) return running.get(key);
  const run = runJob(key, trigger, triggeredBy).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

async function runJob(key, trigger, triggeredBy) {
  const definition = definitions.get(key);
  const startedAt = new Date();
  const run = await CronRun.create({ job: key, trigger, triggeredBy, startedAt });
  broadcast('cron', { key, status: 'running' }, { audience: 'admins' });

  let status = 'success';
  let summary = null;
  let details = null;
  let error = null;
  try {
    const result = await definition.run();
    summary = result?.summary ?? 'Completed';
    details = result?.details ?? null;
  } catch (failure) {
    status = 'failed';
    error = failure?.message ?? String(failure);
    console.error(`[cron ${key}] failed`, failure);
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  Object.assign(run, { status, summary, details, error, finishedAt, durationMs });
  await run.save();
  await CronJob.updateOne(
    { key },
    {
      $set: { lastRunAt: startedAt, lastStatus: status, lastDurationMs: durationMs, lastSummary: summary, lastError: error },
      $inc: { runCount: 1, failCount: status === 'failed' ? 1 : 0 },
    },
  );

  if (status === 'failed') {
    await notify({
      audience: 'admins',
      severity: 'critical',
      category: 'cron',
      title: `Cron job "${definition.name}" failed`,
      message: error,
      meta: { key },
      dedupeKey: `cron-failed:${key}`,
      dedupeMs: 60 * 60 * 1000,
    }).catch(() => {});
  }
  broadcast('cron', { key, status }, { audience: 'admins' });
  return run;
}

function assertDefined(key) {
  if (!definitions.has(key)) throw new HttpError(404, 'Cron job not found');
}
