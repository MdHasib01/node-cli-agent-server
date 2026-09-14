/**
 * Whitelist of supported CLIs. Each entry turns an already-validated request into
 * a command + argv array for spawn(). Nothing from the request is ever run through
 * a shell or used as a command name.
 *
 * Auto-confirm: CLIs run headless with stdin closed, so they can never stop to ask
 * a question. What each CLI may do without asking is set by its flags below.
 */
const CLIS = {
  claude: {
    command: 'claude',
    // -p = non-interactive. acceptEdits auto-approves file writes inside the job's
    // output directory; other tools (e.g. Bash) are denied rather than prompted for.
    buildArgs: ({ type, model, prompt, outputDir }) => [
      '-p',
      '--output-format', 'text',
      '--permission-mode', 'acceptEdits',
      ...modelArgs(model),
      withTask(type, prompt, outputDir),
    ],
    usageArgs: ['--version'],
  },

  agy: {
    command: 'agy',
    // agy uses Go-style flags: the prompt is the value of --print and must come last.
    // Headless agy auto-denies anything it would normally ask about, so every tool
    // permission is granted up front. agy picks its own workspace root (it can be a
    // parent folder of the cwd), so the job directory is added to it explicitly.
    buildArgs: ({ type, model, prompt, outputDir }) => [
      '--dangerously-skip-permissions',
      '--add-dir', outputDir,
      ...modelArgs(model),
      '--print', withTask(type, prompt, outputDir),
    ],
    usageArgs: ['--version'],
  },

  codex: {
    command: 'codex',
    // exec = non-interactive. --full-auto auto-approves inside codex's workspace sandbox.
    buildArgs: ({ type, model, prompt, outputDir }) => [
      'exec',
      '--full-auto',
      '--skip-git-repo-check',
      ...modelArgs(model),
      withTask(type, prompt, outputDir),
    ],
    usageArgs: ['--version'],
  },
};

export const SUPPORTED_CLIS = Object.keys(CLIS);
export const SUPPORTED_TYPES = ['text', 'image'];

export function isSupportedCli(name) {
  return typeof name === 'string' && Object.hasOwn(CLIS, name);
}

export function buildCommand({ cli, type, model, prompt, outputDir }) {
  const entry = CLIS[cli];
  return { command: entry.command, args: entry.buildArgs({ type, model, prompt, outputDir }) };
}

export function buildUsageCommand(cli) {
  const entry = CLIS[cli];
  return { command: entry.command, args: [...entry.usageArgs] };
}

function modelArgs(model) {
  return model ? ['--model', model] : [];
}

// General-purpose agent CLIs get the task type as instructions in the prompt.
// The absolute path matters: some CLIs (agy) resolve a bare file name against their
// own workspace root instead of the working directory. The SVG fallback covers CLIs
// that are not allowed to run shell commands (claude above).
function withTask(type, prompt, outputDir) {
  if (type !== 'image') return prompt;
  return [
    'Create an image based on the description below.',
    `Save it as an image file (PNG, JPG or SVG) in this directory: ${outputDir}`,
    'If you cannot run shell commands, write SVG markup directly into a .svg file there using your file-writing tool.',
    'Then reply with the file name only.',
    '',
    `Description: ${prompt}`,
  ].join('\n');
}
