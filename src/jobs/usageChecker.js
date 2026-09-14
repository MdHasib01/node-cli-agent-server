import { probeAgent } from '../services/agentService.js';
import { SUPPORTED_CLIS, buildUsageCommand } from '../services/cliMapper.js';
import { getStats } from '../services/jobStore.js';

let lastCheck = { checkedAt: null, clis: {} };

/** Health check of every whitelisted CLI: version, sign-in state and provider usage limits. */
export async function checkUsage() {
  const agents = await Promise.all(SUPPORTED_CLIS.map((cli) => probeAgent(cli)));

  lastCheck = {
    checkedAt: new Date().toISOString(),
    clis: Object.fromEntries(
      agents.map((agent) => {
        const { command, args } = buildUsageCommand(agent.cli);
        return [
          agent.cli,
          {
            available: Boolean(agent.installed),
            usageCommand: [command, ...args].join(' '),
            usageOutput: agent.version,
            error: agent.lastError,
            auth: agent.auth?.status ?? 'unknown',
            providerLimits: agent.provider?.available ? agent.provider.windows : null,
          },
        ];
      }),
    ),
  };

  const count = (predicate) => agents.filter(predicate).length;
  const signedIn = count((agent) => agent.auth?.status === 'authenticated');
  const signedOut = count((agent) => agent.auth?.status === 'unauthenticated');
  const missing = count((agent) => agent.installed === false);
  return {
    summary: `${agents.length} agents checked · ${signedIn} signed in · ${signedOut} signed out · ${missing} not installed`,
    details: lastCheck.clis,
  };
}

/** Latest usage check merged with the server's own per-CLI request counters (GET /api/usage). */
export function getUsage() {
  return {
    checkedAt: lastCheck.checkedAt,
    clis: Object.fromEntries(
      SUPPORTED_CLIS.map((cli) => [cli, { ...lastCheck.clis[cli], requests: getStats(cli) }]),
    ),
  };
}

export const USAGE_JOB = {
  key: 'usage-checker',
  name: 'Agent health & usage check',
  description:
    'Checks every CLI agent: installed version, sign-in state and provider usage limits. Alerts everyone when an agent is signed out or close to a limit.',
  run: checkUsage,
};
