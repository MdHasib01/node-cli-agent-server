import { Agent } from '../models/Agent.js';
import { UsageRecord } from '../models/UsageRecord.js';
import { HttpError } from '../utils/httpError.js';
import { intInRange, optionalPositiveInt } from '../utils/validate.js';
import { interpretAuthProbe, looksLikeAuthError, readProviderUsage } from './agentProbes.js';
import { SUPPORTED_CLIS, buildAuthCommand, buildUsageCommand, getCliInfo } from './cliMapper.js';
import { runCommand } from './cliRunner.js';
import { countActiveJobs } from './jobStore.js';
import { broadcast, notify } from './notifications.js';

const PROBE_TIMEOUT_MS = 30000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LIMIT_KEYS = ['requestsPerHour', 'requestsPerDay', 'maxConcurrent', 'tokenBudget5h', 'tokenBudget7d'];

export async function ensureAgents() {
  await Promise.all(SUPPORTED_CLIS.map((cli) => Agent.updateOne({ cli }, { $setOnInsert: { cli } }, { upsert: true })));
}

/** Every whitelisted agent with its settings, latest health check and live request counts. */
export async function listAgents() {
  const now = Date.now();
  const [agents, lastHour, lastDay] = await Promise.all([
    Agent.find({ cli: { $in: SUPPORTED_CLIS } }),
    requestsByCli(new Date(now - HOUR_MS)),
    requestsByCli(new Date(now - DAY_MS)),
  ]);
  const byCli = new Map(agents.map((agent) => [agent.cli, agent]));
  return SUPPORTED_CLIS.map((cli) => {
    const agent = byCli.get(cli);
    return {
      ...(agent ? withTokenBudgets(agent.toJSON()) : { cli, enabled: true, limits: {}, alertThreshold: 80, auth: { status: 'unknown' }, provider: null }),
      ...getCliInfo(cli),
      usage: { lastHour: lastHour[cli] ?? 0, lastDay: lastDay[cli] ?? 0, running: countActiveJobs(cli) },
    };
  });
}

// Token budgets are settings, not measurements: apply the current ones so an edited
// budget shows right away instead of after the next health check. Window keys match
// the ones written by readClaudeUsage (agentProbes.js).
function withTokenBudgets(agent) {
  if (!agent.provider?.windows?.length) return agent;
  const budgets = { '5h': agent.limits?.tokenBudget5h ?? null, '7d': agent.limits?.tokenBudget7d ?? null };
  agent.provider.windows = agent.provider.windows.map((window) => {
    if (window.unit !== 'tokens') return window;
    const limit = budgets[window.key] ?? null;
    return { ...window, limit, usedPercent: limit ? Math.min((window.used / limit) * 100, 100) : null };
  });
  return agent;
}

export async function getAgent(cli) {
  return (await listAgents()).find((agent) => agent.cli === cli);
}

/**
 * Health check for one CLI: installed version, sign-in state and provider usage.
 * Raises notifications when the agent gets signed out, disappears or nears a limit.
 */
export async function probeAgent(cli) {
  const info = getCliInfo(cli);
  const previous = await Agent.findOne({ cli }).lean();

  const version = await runCommand({ ...buildUsageCommand(cli), timeoutMs: PROBE_TIMEOUT_MS });
  const installed = !version.notFound;

  let auth = null;
  const authCommand = buildAuthCommand(cli);
  if (!installed) {
    auth = { status: 'unknown', method: null, detail: 'CLI is not installed or not on PATH' };
  } else if (authCommand) {
    auth = interpretAuthProbe(await runCommand({ ...authCommand, timeoutMs: PROBE_TIMEOUT_MS }));
  }
  // CLIs without a status command keep the state inferred from their last requests (see observeJob).

  const provider = await readProviderUsage(cli, previous);

  // Sign-in state first: a check that reads as finished (lastCheckedAt) never shows a stale state.
  if (auth) await setAuthStatus(cli, { ...auth, source: 'probe' });

  const now = new Date();
  await Agent.updateOne(
    { cli },
    {
      $set: {
        installed,
        version: version.ok ? firstLine(version.stdout) : null,
        binaryPath: version.location ?? null,
        provider: { ...provider, checkedAt: now },
        lastCheckedAt: now,
        lastError: version.ok ? null : version.error,
      },
    },
    { upsert: true },
  );

  if (previous?.installed === true && !installed) {
    await notify({
      audience: 'all',
      severity: 'warning',
      category: 'system',
      title: `${info.label} is no longer available`,
      message: `"${cli}" could not be started on the server. Reinstall it or check the PATH of the server process.`,
      meta: { cli },
      dedupeKey: `missing:${cli}`,
      dedupeMs: 6 * HOUR_MS,
    });
  }
  await raiseProviderAlerts(cli, info.label, provider, previous?.alertThreshold ?? 80);

  broadcast('agents', { cli });
  return Agent.findOne({ cli });
}

/** Records the sign-in state of an agent and alerts everyone when it changes. */
export async function setAuthStatus(cli, { status, method = null, detail = null, source }) {
  const previous = await Agent.findOne({ cli }, { auth: 1 }).lean();
  const previousStatus = previous?.auth?.status ?? 'unknown';
  const changed = previousStatus !== status;
  const now = new Date();

  await Agent.updateOne(
    { cli },
    {
      $set: {
        'auth.status': status,
        'auth.method': method ?? previous?.auth?.method ?? null,
        'auth.detail': detail,
        'auth.source': source,
        'auth.checkedAt': now,
        ...(changed ? { 'auth.changedAt': now } : {}),
      },
    },
    { upsert: true },
  );
  if (!changed) return;

  const { label, loginCommand } = getCliInfo(cli);
  if (status === 'unauthenticated') {
    await notify({
      audience: 'all',
      severity: 'critical',
      category: 'auth',
      title: `${label} is signed out`,
      message: `${detail ? `${detail}. ` : ''}Requests to "${cli}" will fail until someone runs "${loginCommand}" on the server host.`,
      meta: { cli, loginCommand },
      dedupeKey: `auth:${cli}:signed-out`,
      dedupeMs: 30 * 60 * 1000,
    });
  } else if (status === 'authenticated' && previousStatus === 'unauthenticated') {
    await notify({
      audience: 'all',
      severity: 'success',
      category: 'auth',
      title: `${label} is signed in again`,
      message: `"${cli}" can accept requests again.`,
      meta: { cli },
      // Caps noise if the probe and request results ever disagree and the state flips back and forth.
      dedupeKey: `auth:${cli}:signed-in`,
      dedupeMs: 30 * 60 * 1000,
    });
  }
  broadcast('agents', { cli });
}

/** Infers the sign-in state from a finished request (the only signal for CLIs without a status command). */
export async function observeJob(job) {
  if (job.status === 'succeeded') {
    const agent = await Agent.findOne({ cli: job.cli }, { auth: 1 }).lean();
    if (agent?.auth?.status !== 'authenticated') {
      await setAuthStatus(job.cli, {
        status: 'authenticated',
        method: agent?.auth?.method ?? null,
        detail: 'Verified by a successful request',
        source: 'job',
      });
    }
    return;
  }
  if (job.status === 'failed' && looksLikeAuthError(job.error)) {
    await setAuthStatus(job.cli, {
      status: 'unauthenticated',
      detail: String(job.error).split('\n')[0].slice(0, 300),
      source: 'job',
    });
  }
}

/** Rejects a request that the agent's or the token's limits don't allow. */
export async function enforceLimits({ cli, auth }) {
  const { label } = getCliInfo(cli);
  const agent = await Agent.findOne({ cli }, { enabled: 1, limits: 1 }).lean();
  if (agent?.enabled === false) {
    throw new HttpError(403, `The ${label} agent is disabled by an administrator`);
  }

  const token = auth.token;
  if (token?.allowedClis?.length && !token.allowedClis.includes(cli)) {
    throw new HttpError(403, `This API token is not allowed to use "${cli}"`);
  }
  if (token?.dailyLimit) {
    const used = await UsageRecord.countDocuments({ token: token._id, createdAt: { $gte: new Date(Date.now() - DAY_MS) } });
    if (used >= token.dailyLimit) {
      throw new HttpError(429, `This API token reached its limit of ${token.dailyLimit} requests per 24 hours`);
    }
  }

  const limits = agent?.limits ?? {};
  if (limits.maxConcurrent && countActiveJobs(cli) >= limits.maxConcurrent) {
    throw new HttpError(429, `${label} is busy: ${limits.maxConcurrent} request(s) already running`);
  }
  for (const [limit, windowMs, period] of [
    [limits.requestsPerHour, HOUR_MS, 'hour'],
    [limits.requestsPerDay, DAY_MS, '24 hours'],
  ]) {
    if (!limit) continue;
    const used = await UsageRecord.countDocuments({ cli, createdAt: { $gte: new Date(Date.now() - windowMs) } });
    if (used >= limit) throw new HttpError(429, `${label} reached its limit of ${limit} requests per ${period}`);
  }
}

/** Warns admins when an agent's request counts cross its alert threshold. */
export async function checkRequestLimitAlerts(cli) {
  const agent = await Agent.findOne({ cli }, { limits: 1, alertThreshold: 1 }).lean();
  const limits = agent?.limits ?? {};
  const threshold = (agent?.alertThreshold ?? 80) / 100;
  const { label } = getCliInfo(cli);

  for (const [limit, windowMs, period] of [
    [limits.requestsPerHour, HOUR_MS, 'hourly'],
    [limits.requestsPerDay, DAY_MS, 'daily'],
  ]) {
    if (!limit) continue;
    const used = await UsageRecord.countDocuments({ cli, createdAt: { $gte: new Date(Date.now() - windowMs) } });
    if (used < limit * threshold) continue;
    const full = used >= limit;
    await notify({
      audience: 'admins',
      severity: full ? 'critical' : 'warning',
      category: 'usage',
      title: `${label} used ${used} of ${limit} ${period} requests`,
      message: full ? 'New requests are rejected until the window frees up.' : `Alert threshold is ${Math.round(threshold * 100)}%.`,
      meta: { cli, period, used, limit },
      dedupeKey: `requests:${cli}:${period}:${full ? 'full' : 'warn'}`,
      dedupeMs: windowMs,
    });
  }
}

export async function updateAgentSettings(cli, body) {
  const update = {};
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false');
    update.enabled = body.enabled;
  }
  if ('alertThreshold' in body) {
    update.alertThreshold = intInRange(body.alertThreshold, 'alertThreshold', 1, 100);
  }
  if (body.limits !== undefined) {
    if (!body.limits || typeof body.limits !== 'object') throw new HttpError(400, '"limits" must be an object');
    for (const key of LIMIT_KEYS) {
      if (key in body.limits) update[`limits.${key}`] = optionalPositiveInt(body.limits[key], `limits.${key}`, { max: 1e12 });
    }
  }
  if (Object.keys(update).length === 0) throw new HttpError(400, 'Nothing to update');

  await Agent.updateOne({ cli }, { $set: update }, { upsert: true, runValidators: true });
  broadcast('agents', { cli });
}

async function raiseProviderAlerts(cli, label, provider, threshold) {
  if (!provider?.available) return;

  if (provider.reached) {
    await notify({
      audience: 'all',
      severity: 'critical',
      category: 'usage',
      title: `${label} hit its usage limit`,
      message: `The provider reports that the "${provider.reached}" limit was reached. Requests fail until it resets.`,
      meta: { cli },
      dedupeKey: `provider-reached:${cli}:${provider.reached}`,
      dedupeMs: 6 * HOUR_MS,
    });
  }

  for (const window of provider.windows ?? []) {
    if (window.stale || typeof window.usedPercent !== 'number' || window.usedPercent < threshold) continue;
    const critical = window.usedPercent >= 95;
    await notify({
      audience: 'all',
      severity: critical ? 'critical' : 'warning',
      category: 'usage',
      title: `${label}: ${window.label} at ${Math.round(window.usedPercent)}%`,
      message: window.resetsAt
        ? `Resets ${window.resetsAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.`
        : `The alert threshold is ${threshold}%.`,
      meta: { cli, window: window.key, usedPercent: window.usedPercent, resetsAt: window.resetsAt ?? null },
      // One alert per window and severity: a new window (new reset time) can alert again.
      dedupeKey: `provider:${cli}:${window.key}:${critical ? 'critical' : 'warning'}:${window.resetsAt?.getTime() ?? 'rolling'}`,
      dedupeMs: window.resetsAt ? 8 * DAY_MS : 6 * HOUR_MS,
    });
  }
}

async function requestsByCli(since) {
  const rows = await UsageRecord.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$cli', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

function firstLine(text) {
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 120) ?? null;
}
