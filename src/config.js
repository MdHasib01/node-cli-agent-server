import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

function positiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  port: positiveInt('PORT', 3000),
  defaultCli: process.env.DEFAULT_CLI?.trim() || 'agy',
  defaultModel: process.env.DEFAULT_MODEL?.trim() || 'default',
  cliTimeout: positiveInt('CLI_TIMEOUT', 60000),
  apiKey: process.env.API_KEY?.trim() || '',
  outputsDir: path.join(ROOT_DIR, 'outputs'),
};
