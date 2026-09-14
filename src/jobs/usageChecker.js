import cron from 'node-cron';
import { SUPPORTED_CLIS, buildUsageCommand } from '../services/cliMapper.js';
import { runCommand } from '../services/cliRunner.js';
import { getStats } from '../services/jobStore.js';

const USAGE_SCHEDULE = '*/5 * * * *';
const USAGE_TIMEOUT_MS = 30000;

let lastCheck = { checkedAt: null, clis: {} };

/** Runs the usage command of every whitelisted CLI and stores the results. */
export async function checkUsage() {
  const entries = await Promise.all(
    SUPPORTED_CLIS.map(async (cli) => {
      const { command, args } = buildUsageCommand(cli);
      const result = await runCommand({ command, args, timeoutMs: USAGE_TIMEOUT_MS });
      return [cli, {
        available: result.ok,
        usageCommand: [command, ...args].join(' '),
        usageOutput: result.ok ? result.stdout.trim() : null,
        error: result.error,
      }];
    }),
  );
  lastCheck = { checkedAt: new Date().toISOString(), clis: Object.fromEntries(entries) };
  return lastCheck;
}

/** Latest usage check merged with the server's own per-CLI request counters. */
export function getUsage() {
  return {
    checkedAt: lastCheck.checkedAt,
    clis: Object.fromEntries(
      SUPPORTED_CLIS.map((cli) => [cli, { ...lastCheck.clis[cli], requests: getStats(cli) }]),
    ),
  };
}

export function startUsageChecker() {
  const run = () => checkUsage().catch((error) => console.error('[usage] check failed', error));
  run();
  return cron.schedule(USAGE_SCHEDULE, run, { name: 'usage-checker', noOverlap: true });
}
