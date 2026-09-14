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

// GET /api/jobs/:id
export function getJobById(req, res) {
  const job = getJob(req.params.id);
  if (!job) throw new HttpError(404, 'Job not found');
  res.json(job);
}

// GET /api/usage
export function usage(req, res) {
  res.json(getUsage());
}
