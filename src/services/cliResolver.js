import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';
const FOUND_TTL_MS = 60_000;
const MISSING_TTL_MS = 10_000;

// Folders CLIs install themselves into, searched after PATH in case PATH doesn't list them.
const KNOWN_DIRS = IS_WINDOWS
  ? ['%LOCALAPPDATA%\\agy\\bin', '%USERPROFILE%\\.local\\bin', '%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin', '%APPDATA%\\npm']
  : ['~/.local/bin', '/usr/local/bin', '/opt/homebrew/bin', '~/.npm-global/bin', '/usr/bin'];

// `${command}|${override}` -> { value, expires }
const cache = new Map();
let registryCache = { dirs: [], expires: 0 };

/**
 * Finds the executable behind a CLI command. This process's PATH is a snapshot from when
 * it (or the terminal that started it) launched, so a CLI installed later looks missing.
 * Besides that PATH, this checks the current user/system PATH (Windows registry) and the
 * usual install folders. An explicit `override` path is used as-is and nothing else is tried.
 *
 * Returns { file, args, location, source } or null. `args` are prepended arguments: an npm
 * .cmd shim can't be spawned without a shell, so its script is run through node instead.
 */
export async function resolveCommand(command, { override = null } = {}) {
  const key = `${command}|${override ?? ''}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = override ? await fromFile(expandHome(override), 'override') : await search(command);
  cache.set(key, { value, expires: Date.now() + (value ? FOUND_TTL_MS : MISSING_TTL_MS) });
  return value;
}

export function forgetCommand(command) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${command}|`)) cache.delete(key);
  }
}

/** Environment for child processes, with PATH brought up to date so CLIs find their own tools. */
export async function childEnv() {
  if (!IS_WINDOWS) return { ...process.env };
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'Path';
  const dirs = [...splitPath(process.env[key] ?? ''), ...(await registryPathDirs())];
  const unique = [...new Map(dirs.map((dir) => [dir.toLowerCase(), dir])).values()];
  return { ...process.env, [key]: unique.join(path.delimiter) };
}

async function search(command) {
  const sources = [
    ['path', splitPath(process.env.PATH ?? '')],
    ['system-path', await registryPathDirs()],
    ['known-location', KNOWN_DIRS.map(expandDir)],
  ];
  const seen = new Set();
  for (const [source, dirs] of sources) {
    for (const dir of dirs) {
      const id = IS_WINDOWS ? dir.toLowerCase() : dir;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const name of candidateNames(command)) {
        const found = await fromFile(path.join(dir, name), source);
        if (found) return found;
      }
    }
  }
  return null;
}

async function fromFile(file, source) {
  if (!(await isFile(file))) return null;
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(file)) return fromCmdShim(file, source);
  return { file, args: [], location: file, source };
}

// npm-style shim: `"%_prog%" "%dp0%\node_modules\pkg\cli.js" %*` -> run the target directly.
async function fromCmdShim(file, source) {
  const text = await readFile(file, 'utf8').catch(() => '');
  const target = text.match(/"%(?:dp0%|~dp0)\\?([^"]+)"\s+%\*/i)?.[1];
  if (!target) return null;

  const script = path.join(path.dirname(file), target);
  if (!(await isFile(script))) return null;
  if (/\.exe$/i.test(script)) return { file: script, args: [], location: file, source };
  if (!/\.[cm]?js$/i.test(script)) return null;

  // Like the shim itself: prefer a node.exe next to it, else the node running this server.
  const bundledNode = path.join(path.dirname(file), 'node.exe');
  return { file: (await isFile(bundledNode)) ? bundledNode : process.execPath, args: [script], location: file, source };
}

function candidateNames(command) {
  if (!IS_WINDOWS || path.extname(command)) return [command];
  return [`${command}.exe`, `${command}.com`, `${command}.cmd`, `${command}.bat`];
}

/** The PATH Windows gives newly started programs right now (system, then user). */
async function registryPathDirs() {
  if (!IS_WINDOWS) return [];
  if (registryCache.expires > Date.now()) return registryCache.dirs;

  const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const keys = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'];
  const dirs = [];
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync(reg, ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 5000 });
      const value = stdout.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im)?.[1];
      if (value) dirs.push(...splitPath(expandWindowsVars(value.trim())));
    } catch {
      // Value not set for this scope.
    }
  }
  registryCache = { dirs, expires: Date.now() + FOUND_TTL_MS };
  return dirs;
}

function splitPath(value) {
  return value
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function expandWindowsVars(value) {
  return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
}

function expandHome(value) {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function expandDir(dir) {
  return IS_WINDOWS ? expandWindowsVars(dir) : expandHome(dir);
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
