import { mkdirSync } from 'node:fs';
import app from './app.js';
import { config } from './config.js';
import { startUsageChecker } from './jobs/usageChecker.js';
import { killAllRunning } from './services/cliRunner.js';

mkdirSync(config.outputsDir, { recursive: true });

const server = app.listen(config.port, (error) => {
  if (error) {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
  console.log(`CLI API server listening on http://localhost:${config.port}`);
  console.log(`Default CLI: ${config.defaultCli}, default model: ${config.defaultModel}, timeout: ${config.cliTimeout} ms`);
  if (!config.apiKey) {
    console.warn('API_KEY is not set: the API is open to anyone who can reach this port.');
  }
});

const usageTask = startUsageChecker();

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  usageTask.stop();
  killAllRunning();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
