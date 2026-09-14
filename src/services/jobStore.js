import { v4 as uuidv4 } from 'uuid';

const MAX_JOBS = 1000;

const jobs = new Map();
// Cumulative per-CLI counters; kept separately so pruning old jobs doesn't lose them.
const stats = {};

export function createJob({ cli, model, type, prompt, ownerId = null }) {
  const job = {
    id: uuidv4(),
    status: 'queued',
    // Id of the user whose token/session created the job; null for the legacy API_KEY.
    ownerId,
    cli,
    model,
    type,
    prompt,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    output: null,
    outputTruncated: false,
    files: [],
    error: null,
  };
  jobs.set(job.id, job);
  prune();
  return job;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
  return job ?? null;
}

export function finishJob(id, patch) {
  const job = updateJob(id, { ...patch, finishedAt: new Date().toISOString() });
  if (!job) return null;

  const cliStats = (stats[job.cli] ??= emptyStats());
  cliStats.requests += 1;
  if (job.status === 'succeeded') cliStats.succeeded += 1;
  else cliStats.failed += 1;
  if (job.status === 'timed_out') cliStats.timedOut += 1;
  cliStats.totalDurationMs += job.durationMs ?? 0;
  cliStats.lastUsedAt = job.finishedAt;
  return job;
}

/** Jobs of a CLI that are queued or running right now. */
export function countActiveJobs(cli) {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.cli === cli && !job.finishedAt) count += 1;
  }
  return count;
}

export function getStats(cli) {
  const cliStats = stats[cli] ?? emptyStats();
  return {
    ...cliStats,
    avgDurationMs: cliStats.requests ? Math.round(cliStats.totalDurationMs / cliStats.requests) : null,
  };
}

function emptyStats() {
  return { requests: 0, succeeded: 0, failed: 0, timedOut: 0, totalDurationMs: 0, lastUsedAt: null };
}

// Map iterates in insertion order, so the oldest finished jobs are dropped first.
function prune() {
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.finishedAt) jobs.delete(id);
  }
}
