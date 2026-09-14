import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../config.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Only the end of a session log is read: rate-limit events are appended as the session runs.
const TAIL_BYTES = 4 * 1024 * 1024;

// Text CLIs print when their stored sign-in is missing, expired or rejected.
const AUTH_ERROR_PATTERNS = [
  /not (logged|signed) in/i,
  /(log|sign) ?in (again|required)/i,
  /please (run|use)\b.{0,40}\b(login|log in|auth)/i,
  /authenticat(ion|e) (failed|required|error)/i,
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /invalid[ _-](api[ _-]?key|token|credentials|x-api-key)/i,
  /(token|session|credentials?|login) (has |have )?(expired|been revoked)/i,
  /oauth.{0,40}(expired|revoked|invalid)/i,
  /re-?authenticate/i,
];

export function looksLikeAuthError(text) {
  return Boolean(text) && AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Turns the result of a CLI's sign-in status command (`claude auth status`,
 * `codex login status`) into authenticated / unauthenticated / unknown.
 */
export function interpretAuthProbe(result) {
  if (result.notFound) {
    return { status: 'unknown', method: null, detail: 'CLI is not installed or not on PATH' };
  }

  const stdout = result.stdout.trim();
  const text = `${stdout}\n${result.stderr}`.trim();

  const json = parseJson(stdout);
  if (json && typeof json.loggedIn === 'boolean') {
    return {
      status: json.loggedIn ? 'authenticated' : 'unauthenticated',
      method: [json.authMethod, json.subscriptionType].filter((part) => typeof part === 'string' && part).join(' · ') || null,
      detail: json.loggedIn ? 'Signed in' : 'Not signed in',
    };
  }

  if (/not (logged|signed) in|logged out|no (stored )?credentials/i.test(text) || (!result.ok && looksLikeAuthError(text))) {
    return { status: 'unauthenticated', method: null, detail: firstLine(text) ?? 'Not signed in' };
  }
  if (result.timedOut) {
    return { status: 'unknown', method: null, detail: 'The sign-in check timed out' };
  }
  if (/unknown (command|option|argument)|unrecognized|usage:/i.test(text) && !/logged in/i.test(text)) {
    return { status: 'unknown', method: null, detail: 'This CLI version has no sign-in status command' };
  }
  if (result.ok) {
    return { status: 'authenticated', method: authMethodFromText(text), detail: 'Signed in' };
  }
  return { status: 'unknown', method: null, detail: result.error ?? firstLine(text) ?? 'Sign-in state could not be determined' };
}

/** Usage-limit data for a CLI, read from what the CLI itself leaves on this machine. */
export async function readProviderUsage(cli, agent) {
  if (!config.providerUsageScan) {
    return { available: false, windows: [], note: 'Provider usage scanning is turned off (PROVIDER_USAGE_SCAN=false).' };
  }
  try {
    if (cli === 'codex') return await readCodexLimits();
    if (cli === 'claude') return await readClaudeUsage(agent?.limits ?? {});
    return {
      available: false,
      windows: [],
      note: 'This CLI does not expose its usage limits to local tools. Requests made through this server are tracked below.',
    };
  } catch (error) {
    return { available: false, windows: [], note: `Could not read usage data: ${error.message}` };
  }
}

// --- Codex: rate limits reported by the ChatGPT backend, logged in each session file ---

const WINDOW_LABELS = { 300: '5-hour window', 1440: 'Daily window', 10080: 'Weekly window' };

async function readCodexLimits() {
  const source = 'Codex session logs';
  const files = await newestFiles(
    path.join(config.codexHome, 'sessions'),
    (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
    10,
  );

  for (const file of files) {
    const event = await lastJsonLineContaining(file, '"rate_limits"');
    const limits = event?.payload?.rate_limits ?? event?.rate_limits;
    if (!limits) continue;

    const now = Date.now();
    const observedAt = parseDate(event.timestamp);
    const windows = [
      ['primary', limits.primary],
      ['secondary', limits.secondary],
    ]
      .filter(([, window]) => window && typeof window.used_percent === 'number')
      .map(([key, window]) => {
        const resetsAt = resetTime(window, observedAt);
        const stale = Boolean(resetsAt && resetsAt.getTime() <= now);
        return {
          key,
          label: WINDOW_LABELS[window.window_minutes] ?? `${window.window_minutes}-minute window`,
          unit: 'percent',
          usedPercent: stale ? 0 : clampPercent(window.used_percent),
          windowMinutes: window.window_minutes ?? null,
          resetsAt,
          stale,
        };
      });

    return {
      available: true,
      source,
      plan: limits.plan_type ?? null,
      reached: windows.some((window) => !window.stale) ? limits.rate_limit_reached_type ?? null : null,
      observedAt,
      note: 'Codex reports these numbers while a session runs, so they are as fresh as the last Codex request on this machine.',
      windows,
    };
  }

  return {
    available: false,
    source,
    windows: [],
    note: 'No Codex session with rate-limit data yet. Any Codex request will populate it.',
  };
}

function resetTime(window, observedAt) {
  if (Number.isFinite(window.resets_at)) return new Date(window.resets_at * 1000);
  if (Number.isFinite(window.resets_in_seconds) && observedAt) {
    return new Date(observedAt.getTime() + window.resets_in_seconds * 1000);
  }
  return null;
}

// --- Claude Code: token usage measured from local session logs ---

// file -> { mtimeMs, size, entries }: unchanged session files are not re-read on every check.
const claudeFileCache = new Map();

async function readClaudeUsage({ tokenBudget5h = null, tokenBudget7d = null }) {
  const source = 'Claude Code session logs';
  const now = Date.now();
  const since7d = now - 7 * DAY_MS;
  const since5h = now - 5 * HOUR_MS;

  const files = await filesModifiedSince(path.join(config.claudeHome, 'projects'), (name) => name.endsWith('.jsonl'), since7d);
  if (files === null) {
    return { available: false, source, windows: [], note: 'No Claude Code session logs found on this machine.' };
  }

  const seen = new Set();
  let tokens5h = 0;
  let tokens7d = 0;
  let lastAt = 0;
  for (const { file, mtimeMs, size } of files) {
    for (const entry of await claudeEntries(file, mtimeMs, size)) {
      // Streamed responses repeat the same message; count each one once.
      if (entry.at < since7d || seen.has(entry.id)) continue;
      seen.add(entry.id);
      tokens7d += entry.tokens;
      if (entry.at >= since5h) tokens5h += entry.tokens;
      lastAt = Math.max(lastAt, entry.at);
    }
  }

  const live = new Set(files.map(({ file }) => file));
  for (const file of claudeFileCache.keys()) {
    if (!live.has(file)) claudeFileCache.delete(file);
  }

  return {
    available: true,
    source,
    plan: null,
    reached: null,
    observedAt: lastAt ? new Date(lastAt) : null,
    note: 'Tokens used by Claude Code on this machine (input + output + cache writes). Anthropic does not publish exact plan limits, so set a token budget to track them as a percentage.',
    windows: [
      tokenWindow('5h', 'Last 5 hours', tokens5h, tokenBudget5h, 300),
      tokenWindow('7d', 'Last 7 days', tokens7d, tokenBudget7d, 10080),
    ],
  };
}

function tokenWindow(key, label, used, limit, windowMinutes) {
  return {
    key,
    label,
    unit: 'tokens',
    used,
    limit: limit ?? null,
    usedPercent: limit ? clampPercent((used / limit) * 100) : null,
    windowMinutes,
    resetsAt: null,
    stale: false,
  };
}

async function claudeEntries(file, mtimeMs, size) {
  const cached = claudeFileCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.entries;

  const since = Date.now() - 7 * DAY_MS;
  const entries = [];
  const lines = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Cheap pre-filter: only assistant messages carry a usage block.
    if (!line.includes('"usage"')) continue;
    const entry = parseJson(line);
    const usage = entry?.message?.usage;
    if (entry?.type !== 'assistant' || !usage) continue;
    const at = Date.parse(entry.timestamp);
    if (!(at >= since)) continue;
    entries.push({
      id: `${entry.message.id ?? ''}:${entry.requestId ?? entry.uuid ?? ''}`,
      at,
      tokens: count(usage.input_tokens) + count(usage.output_tokens) + count(usage.cache_creation_input_tokens),
    });
  }

  claudeFileCache.set(file, { mtimeMs, size, entries });
  return entries;
}

// --- helpers ---

/** Newest files first, walking date-named folders (YYYY/MM/DD) in descending order. */
async function newestFiles(dir, match, limit, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    if (out.length >= limit) break;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await newestFiles(fullPath, match, limit, out);
    else if (entry.isFile() && match(entry.name)) out.push(fullPath);
  }
  return out;
}

/** Files under `dir` modified since `since`; null when `dir` does not exist. */
async function filesModifiedSince(dir, match, since, depth = 0, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return depth === 0 ? null : out;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) {
      await filesModifiedSince(fullPath, match, since, depth + 1, out);
    } else if (entry.isFile() && match(entry.name)) {
      const info = await stat(fullPath).catch(() => null);
      if (info && info.mtimeMs >= since) out.push({ file: fullPath, mtimeMs: info.mtimeMs, size: info.size });
    }
  }
  return out;
}

async function lastJsonLineContaining(file, needle) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes(needle)) continue;
      const parsed = parseJson(lines[index]);
      if (parsed) return parsed;
    }
    return null;
  } finally {
    await handle.close();
  }
}

function parseJson(text) {
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function firstLine(text) {
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 300) ?? null;
}

function authMethodFromText(text) {
  if (/chatgpt/i.test(text)) return 'ChatGPT';
  if (/api key/i.test(text)) return 'API key';
  if (/claude\.ai|subscription/i.test(text)) return 'Claude account';
  return null;
}

function clampPercent(value) {
  return Math.min(Math.max(Number(value) || 0, 0), 100);
}

function count(value) {
  return Number.isFinite(value) ? value : 0;
}
