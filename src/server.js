import { mkdirSync } from 'node:fs';
import app from './app.js';
import { config } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { TOKEN_REVIEW_JOB } from './jobs/tokenReviewer.js';
import { USAGE_JOB } from './jobs/usageChecker.js';
import { ensureAgents } from './services/agentService.js';
import { killAllRunning } from './services/cliRunner.js';
import { defineJob, startCronJobs, stopCronJobs } from './services/cronManager.js';
import { closeStreams } from './services/notifications.js';
import { markInterruptedUsage } from './services/usageService.js';

mkdirSync(config.outputsDir, { recursive: true });

let server = null;

async function main() {
  await connectDatabase();
  console.log('Connected to MongoDB');
  await Promise.all([ensureAgents(), markInterruptedUsage()]);

  defineJob({ ...USAGE_JOB, defaultSchedule: config.usageCheckSchedule, runOnStart: true });
  defineJob({ ...TOKEN_REVIEW_JOB, defaultSchedule: config.tokenReviewSchedule, runOnStart: true });

  server = app.listen(config.port, (error) => {
    if (error) {
      console.error(`Failed to start server: ${error.message}`);
      process.exit(1);
    }
    console.log(`CLI API server listening on http://localhost:${config.port}`);
    console.log(`Default CLI: ${config.defaultCli}, default model: ${config.defaultModel}, timeout: ${config.cliTimeout} ms`);
    if (!config.jwtSecret) {
      console.warn('JWT_SECRET is not set: dashboard sessions are signed with a random key and end on every restart.');
    }
  });

  await startCronJobs();
}

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  stopCronJobs();
  killAllRunning();
  closeStreams();
  const exit = () => disconnectDatabase().finally(() => process.exit(0));
  if (server) server.close(exit);
  else exit();
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exit(1);
});
