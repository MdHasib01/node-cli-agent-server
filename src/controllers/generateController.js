import { config } from '../config.js';
import { SUPPORTED_CLIS, SUPPORTED_TYPES, isSupportedCli } from '../services/cliMapper.js';
import { runJob } from '../services/cliRunner.js';
import { createJob } from '../services/jobStore.js';
import { HttpError } from '../utils/httpError.js';
import { sanitizeModel, sanitizePrompt } from '../utils/sanitizer.js';

const STATUS_CODES = { succeeded: 200, failed: 502, timed_out: 504 };

/**
 * POST /api/generate
 * Body: { cli?, model?, type?, prompt, async? }
 * Waits for the CLI and returns the finished job, or with `async: true`
 * returns 202 immediately and the job can be polled at /api/jobs/:id.
 */
export async function generate(req, res) {
  const body = req.body ?? {};

  const cli = body.cli ?? config.defaultCli;
  if (!isSupportedCli(cli)) {
    throw new HttpError(400, `"cli" must be one of: ${SUPPORTED_CLIS.join(', ')}`);
  }

  const type = body.type ?? 'text';
  if (!SUPPORTED_TYPES.includes(type)) {
    throw new HttpError(400, `"type" must be one of: ${SUPPORTED_TYPES.join(', ')}`);
  }

  const model = resolveModel(body.model);
  const prompt = sanitizePrompt(body.prompt);

  const job = createJob({ cli, model, type, prompt });

  if (body.async === true) {
    runJob(job);
    res.status(202).json({ jobId: job.id, status: job.status, statusUrl: `/api/jobs/${job.id}` });
    return;
  }

  const finished = await runJob(job);
  res.status(STATUS_CODES[finished.status] ?? 500).json(finished);
}

// null means "no --model flag": the CLI falls back to its own default model.
function resolveModel(requested) {
  if (requested !== undefined && requested !== null && typeof requested !== 'string') {
    throw new HttpError(400, '"model" must be a string');
  }
  const model = requested?.trim() || config.defaultModel;
  return model === 'default' ? null : sanitizeModel(model);
}
