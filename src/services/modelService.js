import { buildModelListCommand } from './cliMapper.js';
import { runCommand } from './cliRunner.js';

const CACHE_MS = 5 * 60 * 1000;
const MODEL_TIMEOUT_MS = 30_000;
const cache = new Map();
const pending = new Map();

const DEFAULT_MODEL = {
  id: 'default',
  label: 'Default',
  description: "Use this CLI's configured default model",
};

const FALLBACKS = {
  claude: [
    DEFAULT_MODEL,
    { id: 'sonnet', label: 'Sonnet', description: 'Claude Sonnet alias' },
    { id: 'opus', label: 'Opus', description: 'Claude Opus alias' },
    { id: 'fable', label: 'Fable', description: 'Claude Fable alias' },
  ],
  agy: [DEFAULT_MODEL],
  codex: [DEFAULT_MODEL],
};

export async function getModelCatalog(cli) {
  const saved = cache.get(cli);
  if (saved && Date.now() - saved.cachedAt < CACHE_MS) return saved.value;
  if (pending.has(cli)) return pending.get(cli);

  const request = loadCatalog(cli).finally(() => pending.delete(cli));
  pending.set(cli, request);
  return request;
}

async function loadCatalog(cli) {
  const command = buildModelListCommand(cli);
  if (!command) return remember(cli, FALLBACKS[cli] ?? [DEFAULT_MODEL], 'aliases');

  const result = await runCommand({ ...command, timeoutMs: MODEL_TIMEOUT_MS });
  if (!result.ok) {
    return remember(cli, FALLBACKS[cli] ?? [DEFAULT_MODEL], 'fallback', cleanWarning(result.error));
  }

  try {
    const discovered = cli === 'codex' ? parseCodexModels(result.stdout) : parseAgyModels(result.stdout);
    if (!discovered.length) {
      return remember(cli, FALLBACKS[cli] ?? [DEFAULT_MODEL], 'fallback', 'The CLI returned an empty model list');
    }
    return remember(cli, [DEFAULT_MODEL, ...discovered], 'cli');
  } catch (error) {
    return remember(cli, FALLBACKS[cli] ?? [DEFAULT_MODEL], 'fallback', cleanWarning(error?.message));
  }
}

function parseCodexModels(stdout) {
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) throw new Error('Codex did not return a JSON model catalog');
  const payload = JSON.parse(stdout.slice(jsonStart));
  const models = Array.isArray(payload) ? payload : payload.models;
  if (!Array.isArray(models)) throw new Error('Codex returned an invalid model catalog');

  const visible = models.filter((model) => model?.slug && model.visibility !== 'hide');
  return visible.map((model) => ({
    id: String(model.slug),
    label: String(model.display_name || model.slug),
    description: typeof model.description === 'string' ? model.description : null,
  }));
}

function parseAgyModels(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^fetching\b/i.test(line))
    .map((line) => {
      const match = line.match(/^(\S+)\s+(.+)$/);
      return match ? { id: match[1], label: match[2].trim(), description: null } : null;
    })
    .filter(Boolean);
}

function remember(cli, models, source, warning = null) {
  const seen = new Set();
  const value = {
    cli,
    source,
    warning,
    models: models.filter((model) => {
      const key = model.id.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    refreshedAt: new Date().toISOString(),
  };
  cache.set(cli, { cachedAt: Date.now(), value });
  return value;
}

function cleanWarning(message) {
  return String(message || 'Could not load the CLI model catalog').trim().slice(-500);
}
