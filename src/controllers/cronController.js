import { getCronJob, listCronJobs, listRuns, runNow, updateCronJob } from '../services/cronManager.js';

// GET /api/cron
export async function getCronJobs(req, res) {
  res.json({ jobs: await listCronJobs() });
}

// GET /api/cron/:key/runs?limit=20
export async function getCronRuns(req, res) {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
  res.json({ runs: await listRuns(req.params.key, limit) });
}

// POST /api/cron/:key/run
export async function runCronJob(req, res) {
  const run = await runNow(req.params.key, req.user);
  res.json({ run, job: await getCronJob(req.params.key) });
}

// PATCH /api/cron/:key — { schedule?, enabled? }
export async function patchCronJob(req, res) {
  const body = req.body ?? {};
  res.json({ job: await updateCronJob(req.params.key, { schedule: body.schedule, enabled: body.enabled }) });
}
