import { config } from '../config.js';
import { getUsage } from '../jobs/usageChecker.js';
import { SUPPORTED_CLIS, SUPPORTED_TYPES } from '../services/cliMapper.js';
import { getJob } from '../services/jobStore.js';
import { HttpError } from '../utils/httpError.js';

// GET /api/clis
export function listClis(req, res) {
  res.json({
    clis: SUPPORTED_CLIS,
    types: SUPPORTED_TYPES,
    defaults: { cli: config.defaultCli, model: config.defaultModel },
  });
}

// GET /api/jobs/:id — users only see their own jobs; admins and the legacy API_KEY see all.
export function getJobById(req, res) {
  const job = getJob(req.params.id);
  if (!job || !canViewJob(job, req.auth)) throw new HttpError(404, 'Job not found');
  res.json(job);
}

function canViewJob(job, auth) {
  if (auth.source === 'api_key' || auth.user?.role === 'admin') return true;
  return job.ownerId === String(auth.user?._id);
}

// GET /api/usage
export function usage(req, res) {
  res.json(getUsage());
}
