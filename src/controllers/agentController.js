import { USAGE_JOB } from '../jobs/usageChecker.js';
import { getAgent, listAgents, probeAgent, updateAgentSettings } from '../services/agentService.js';
import { isSupportedCli } from '../services/cliMapper.js';
import { runNow } from '../services/cronManager.js';
import { HttpError } from '../utils/httpError.js';

// GET /api/agents
export async function getAgents(req, res) {
  res.json({ agents: await listAgents() });
}

// POST /api/agents/check — runs the health-check cron job now (or joins the run in progress).
export async function checkAllAgents(req, res) {
  const run = await runNow(USAGE_JOB.key, req.user);
  res.json({ run, agents: await listAgents() });
}

// POST /api/agents/:cli/check
export async function checkAgent(req, res) {
  const cli = cliParam(req);
  await probeAgent(cli);
  res.json({ agent: await getAgent(cli) });
}

// PATCH /api/agents/:cli (admin) — { enabled?, alertThreshold?, limits? }
export async function patchAgent(req, res) {
  const cli = cliParam(req);
  await updateAgentSettings(cli, req.body ?? {});
  res.json({ agent: await getAgent(cli) });
}

function cliParam(req) {
  if (!isSupportedCli(req.params.cli)) throw new HttpError(404, 'Unknown agent');
  return req.params.cli;
}
