/**
 * Whitelist of supported CLIs. Each entry turns an already-validated request into
 * a command + argv array for spawn(). Nothing from the request is ever run through
 * a shell or used as a command name.
 *
 * Auto-confirm: CLIs run headless with stdin closed, so they can never stop to ask
 * a question. What each CLI may do without asking is set by its flags below.
 *
 * `binEnv` names the .env variable that can point at the executable when it isn't
 * found automatically (see cliResolver.js).
 */
import { INPUTS_DIR } from './jobInputs.js';

const CLIS = {
  claude: {
    command: 'claude',
    binEnv: 'CLAUDE_BIN',
    label: 'Claude Code',
    vendor: 'Anthropic',
    // Reports the signed-in account and exits non-zero when logged out.
    authArgs: ['auth', 'status'],
    modelListArgs: null,
    loginCommand: 'claude auth login',
    // -p = non-interactive. acceptEdits auto-approves file writes inside the job's
    // output directory; other tools (e.g. Bash) are denied rather than prompted for.
    // Context becomes a real system prompt. Claude has no image flag, but can
    // read image files in its working directory, so it is given their paths.
    buildArgs: ({ type, model, prompt, outputDir, images = [], context = '' }) => [
      '-p',
      '--output-format', 'text',
      '--permission-mode', 'acceptEdits',
      ...(context ? ['--append-system-prompt', context] : []),
      ...modelArgs(model),
      withTask(type, prompt, outputDir, { images }),
    ],
    usageArgs: ['--version'],
  },

  agy: {
    command: 'agy',
    binEnv: 'AGY_BIN',
    label: 'Antigravity',
    vendor: 'Google',
    // agy has no status subcommand; listing models needs a valid sign-in, so it doubles as the check.
    authArgs: ['models'],
    modelListArgs: ['models'],
    loginCommand: 'agy (then sign in when prompted)',
    // agy uses Go-style flags: the prompt is the value of --print and must come last.
    // Headless agy auto-denies anything it would normally ask about, so every tool
    // permission is granted up front. agy picks its own workspace root (it can be a
    // parent folder of the cwd), so the job directory is added to it explicitly.
    // No system-prompt or image flags: context goes ahead of the prompt and the
    // images are listed by path (the job dir is already in its workspace).
    buildArgs: ({ type, model, prompt, outputDir, images = [], context = '' }) => [
      '--dangerously-skip-permissions',
      '--add-dir', outputDir,
      ...modelArgs(model),
      '--print', withTask(type, prompt, outputDir, { images, context }),
    ],
    usageArgs: ['--version'],
  },

  codex: {
    command: 'codex',
    binEnv: 'CODEX_BIN',
    label: 'Codex',
    vendor: 'OpenAI',
    // Prints "Logged in using ..." or "Not logged in".
    authArgs: ['login', 'status'],
    // The Codex CLI exposes its current model catalog as JSON.
    modelListArgs: ['debug', 'models'],
    loginCommand: 'codex login',
    // exec = non-interactive. --approve-for-me already enables the workspace-write
    // sandbox, so it must not be combined with an explicit --sandbox option.
    // Images attach natively with --image (the "=" form plus "--" keep the
    // prompt from being read as another image path). No system-prompt flag,
    // so context goes ahead of the prompt.
    buildArgs: ({ type, model, prompt, outputDir, images = [], context = '' }) => [
      'exec',
      '--approve-for-me',
      '--skip-git-repo-check',
      ...modelArgs(model),
      ...images.map((image) => `--image=${image.path}`),
      ...(images.length ? ['--'] : []),
      withTask(type, prompt, outputDir, { images, context, attached: true }),
    ],
    usageArgs: ['--version'],
  },
};

export const SUPPORTED_CLIS = Object.keys(CLIS);
export const SUPPORTED_TYPES = ['text', 'image'];

export function isSupportedCli(name) {
  return typeof name === 'string' && Object.hasOwn(CLIS, name);
}

export function buildCommand({ cli, type, model, prompt, outputDir, images = [], context = '' }) {
  const entry = CLIS[cli];
  return {
    command: entry.command,
    binEnv: entry.binEnv,
    args: entry.buildArgs({ type, model, prompt, outputDir, images, context }),
  };
}

export function buildUsageCommand(cli) {
  const entry = CLIS[cli];
  return { command: entry.command, binEnv: entry.binEnv, args: [...entry.usageArgs] };
}

/** The CLI's sign-in status command, or null when it has none. */
export function buildAuthCommand(cli) {
  const entry = CLIS[cli];
  return entry.authArgs ? { command: entry.command, binEnv: entry.binEnv, args: [...entry.authArgs] } : null;
}

/** The CLI's model catalog command, or null when the CLI only supports aliases. */
export function buildModelListCommand(cli) {
  const entry = CLIS[cli];
  return entry.modelListArgs
    ? { command: entry.command, binEnv: entry.binEnv, args: [...entry.modelListArgs] }
    : null;
}

/** Display metadata for the dashboard. */
export function getCliInfo(cli) {
  const entry = CLIS[cli];
  return {
    cli,
    label: entry.label,
    vendor: entry.vendor,
    loginCommand: entry.loginCommand,
    binEnv: entry.binEnv,
    hasAuthProbe: Boolean(entry.authArgs),
    hasModelCatalog: Boolean(entry.modelListArgs),
  };
}

function modelArgs(model) {
  return model ? ['--model', model] : [];
}

// General-purpose agent CLIs get the task type as instructions in the prompt.
// The absolute path matters: some CLIs (agy) resolve a bare file name against their
// own workspace root instead of the working directory. The SVG fallback covers CLIs
// that are not allowed to run shell commands (claude above).
//
// `context` (standing instructions) and reference `images` are placed ahead of the
// task. `attached` means the CLI already received the images natively, so only
// their order and labels are listed; otherwise their file paths are given.
function withTask(type, prompt, outputDir, { images = [], context = '', attached = false } = {}) {
  const lead = [];
  if (context) {
    lead.push('[CONTEXT - standing instructions; follow them for everything below]', context, '');
  }
  if (images.length) {
    lead.push(
      attached
        ? 'Reference images are attached to this message, in this order:'
        : 'Reference images are saved as files. Open and look at every one of them before you start:',
    );
    for (const image of images) {
      const where = attached ? '' : `${image.path} - `;
      const role = image.role ? `(${image.role}) ` : '';
      lead.push(`${image.index}. ${where}${role}${image.label}`);
    }
    lead.push('');
  }

  const task =
    type !== 'image'
      ? prompt
      : [
          'Create an image based on the description below.',
          `Save it as an image file (PNG, JPG or SVG) in this directory: ${outputDir}`,
          `Save only the new image there - not inside the ${INPUTS_DIR} folder, and do not copy the reference images.`,
          'If you cannot run shell commands, write SVG markup directly into a .svg file there using your file-writing tool.',
          'Then reply with the file name only.',
          '',
          `Description: ${prompt}`,
        ].join('\n');

  return lead.length ? [...lead, task].join('\n') : task;
}
