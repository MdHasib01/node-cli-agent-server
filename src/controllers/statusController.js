import { config } from '../config.js';
import { getUsage } from '../jobs/usageChecker.js';
import { listAgents } from '../services/agentService.js';
import { getCliInfo, SUPPORTED_CLIS, SUPPORTED_TYPES } from '../services/cliMapper.js';
import { getJob } from '../services/jobStore.js';
import { HttpError } from '../utils/httpError.js';
import { MAX_PROMPT_LENGTH } from '../utils/sanitizer.js';
import { MAX_IMAGES } from '../services/jobInputs.js';
import { ensureAbsoluteJobUrls, resolveBaseUrl } from '../utils/url.js';

// GET /api/clis — only the CLIs this caller can actually use: agents an admin
// disabled and CLIs outside the token's allowedClis are left out, so clients
// (e.g. SMASH's model picker) never offer a choice /api/generate would refuse.
export async function listClis(req, res) {
  const allowed = req.auth?.token?.allowedClis?.length ? new Set(req.auth.token.allowedClis) : null;
  // A settings lookup failure must not hide every CLI; fall back to "enabled".
  const agents = await listAgents().catch(() => []);
  const byCli = new Map(agents.map((agent) => [agent.cli, agent]));

  const usable = SUPPORTED_CLIS.filter(
    (cli) => (!allowed || allowed.has(cli)) && byCli.get(cli)?.enabled !== false,
  );
  const health = getUsage().clis;

  res.json({
    clis: usable,
    types: SUPPORTED_TYPES,
    // Lets clients size prompts before sending instead of guessing.
    limits: { maxPromptChars: MAX_PROMPT_LENGTH, maxImages: MAX_IMAGES },
    // Optional POST /api/generate fields this server understands.
    features: ['images', 'context'],
    defaults: {
      cli: usable.includes(config.defaultCli) ? config.defaultCli : (usable[0] ?? null),
      model: config.defaultModel,
    },
    agents: usable.map((cli) => {
      const { label, vendor } = getCliInfo(cli);
      return {
        cli,
        label,
        vendor,
        available: health[cli]?.available ?? null,
        auth: health[cli]?.auth ?? byCli.get(cli)?.auth?.status ?? 'unknown',
      };
    }),
  });
}

// GET /api/jobs/:id — users only see their own jobs; admins and the legacy API_KEY see all.
export function getJobById(req, res) {
  const job = getJob(req.params.id);
  if (!job || !canViewJob(job, req.auth)) throw new HttpError(404, 'Job not found');
  res.json(ensureAbsoluteJobUrls(job, resolveBaseUrl(req)));
}

function canViewJob(job, auth) {
  if (auth.source === 'api_key' || auth.user?.role === 'admin') return true;
  return job.ownerId === String(auth.user?._id);
}

// GET /api/usage
export function usage(req, res) {
  res.json(getUsage());
}
