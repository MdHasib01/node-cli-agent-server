import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

function positiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function flag(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value);
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  port: positiveInt('PORT', 6000),
  defaultCli: process.env.DEFAULT_CLI?.trim() || 'agy',
  defaultModel: process.env.DEFAULT_MODEL?.trim() || 'default',
  cliTimeout: positiveInt('CLI_TIMEOUT', 60000),
  apiKey: process.env.API_KEY?.trim() || '',
  baseUrl: process.env.BASE_URL?.trim().replace(/\/+$/, '') || '',
  outputsDir: path.join(ROOT_DIR, 'outputs'),

  mongoUri: process.env.MONGODB_URI?.trim() || '',
  jwtSecret: process.env.JWT_SECRET?.trim() || '',
  sessionDays: positiveInt('SESSION_DAYS', 7),
  cookieSecure: flag('COOKIE_SECURE', isProduction),
  allowRegistration: flag('ALLOW_REGISTRATION', true),

  // Only used when a cron job is first created; after that the schedule is edited from the dashboard.
  usageCheckSchedule: process.env.USAGE_CHECK_SCHEDULE?.trim() || '*/5 * * * *',
  tokenReviewSchedule: process.env.TOKEN_REVIEW_SCHEDULE?.trim() || '*/15 * * * *',

  providerUsageScan: flag('PROVIDER_USAGE_SCAN', true),
  claudeHome: process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'),
  codexHome: process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'),

  clientDistDir: path.join(ROOT_DIR, '..', 'client', 'dist'),
};
