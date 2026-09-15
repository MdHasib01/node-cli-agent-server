import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { buildCommand } from './cliMapper.js';
import { INPUTS_DIR, saveInputImages } from './jobInputs.js';
import { childEnv, forgetCommand, resolveCommand } from './cliResolver.js';
import { finishJob, updateJob } from './jobStore.js';
import { outputsUrl } from '../utils/url.js';

const MAX_OUTPUT_CHARS = 5_000_000;
const KILL_GRACE_MS = 5000;

const runningChildren = new Set();

/**
 * Runs a command with spawn() (never a shell). Never rejects: spawn errors,
 * non-zero exits and timeouts are all reported in the resolved result.
 * `onOutput` receives stdout/stderr chunks as they arrive.
 * `binEnv` names the environment variable that may hold an explicit path to the executable.
 */
export async function runCommand({ command, args, cwd, timeoutMs = config.cliTimeout, onOutput, binEnv }) {
  const override = binEnv ? process.env[binEnv]?.trim() || null : null;
  const resolved = await resolveCommand(command, { override });
  if (!resolved) {
    return {
      ok: false,
      notFound: true,
      location: null,
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 0,
      error: override
        ? `CLI "${command}" is not installed at ${binEnv} (${override})`
        : `CLI "${command}" is not installed or not on PATH${binEnv ? `. Install it, or set ${binEnv} in server/.env to the full path of its executable` : ''}`,
    };
  }
  const env = { ...(await childEnv()), NO_COLOR: '1' };

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let child;

    const finish = ({ exitCode = null, signal = null, error = null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      if (child) runningChildren.delete(child);
      // The executable disappeared since it was found; look it up again next time.
      if (error?.code === 'ENOENT') forgetCommand(command);

      const ok = !error && !timedOut && exitCode === 0;
      resolve({
        ok,
        notFound: error?.code === 'ENOENT',
        location: resolved.location,
        exitCode,
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        error: ok ? null : describeFailure({ command, error, timedOut, timeoutMs, exitCode, signal, stderr }),
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    try {
      child = spawn(resolved.file, [...resolved.args, ...args], {
        cwd,
        shell: false,
        // stdin closed: any interactive prompt the CLI still shows gets EOF instead of hanging.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so a timeout can kill the CLI together with its subprocesses.
        detached: process.platform !== 'win32',
        windowsHide: true,
        env,
      });
    } catch (error) {
      finish({ error });
      return;
    }

    runningChildren.add(child);

    const append = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return current;
      }
      return current + chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
      onOutput?.(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
      onOutput?.(chunk);
    });

    child.on('error', (error) => finish({ error }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
  });
}

/**
 * Executes a job from the job store inside its own outputs/<jobId> directory and
 * records the result. Never rejects.
 */
export async function runJob(job, inputs = {}) {
  const outputDir = path.join(config.outputsDir, job.id);
  const tag = `[job ${job.id}]`;
  try {
    await mkdir(outputDir, { recursive: true });

    // References arrive as URLs/base64; the CLIs need real files. A job that
    // silently lost its product reference is worse than a failed one.
    let images = [];
    try {
      images = await saveInputImages(inputs.images ?? [], outputDir);
    } catch (error) {
      console.error(`${tag} ${error.message}`);
      return finishJob(job.id, { status: 'failed', error: error.message });
    }
    if (images.length || inputs.context) {
      console.log(`${tag} inputs: ${images.length} reference image(s), ${inputs.context?.length ?? 0} chars of context`);
    }

    const { command, args, binEnv } = buildCommand({ ...job, outputDir, images, context: inputs.context ?? '' });

    updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() });
    console.log(`${tag} ${job.cli} (${job.model ?? 'default model'}) ${job.type}: started`);

    const startedAtMs = Date.now();
    const result = await runCommand({
      command,
      args,
      binEnv,
      cwd: outputDir,
      onOutput: (chunk) => logLines(tag, chunk),
    });
    let files = await collectOutputFiles(job.id, outputDir);
    // An agent told to "save an image here" sometimes just copies the
    // reference it was given. That is never the generated result.
    files = await dropInputCopies(files, images, tag);
    let imageFile = findImageFile(files);

    // Codex renders into its own home and copies the file in afterwards; if
    // that copy never happened, the image still exists - go and fetch it.
    if (job.type === 'image' && !imageFile) {
      const rescued = await rescueGeneratedImage(job, outputDir, startedAtMs, tag);
      if (rescued) {
        files = await dropInputCopies(await collectOutputFiles(job.id, outputDir), images, tag);
        imageFile = findImageFile(files);
      }
    }
    let status = result.ok ? 'succeeded' : result.timedOut ? 'timed_out' : 'failed';
    let error = result.error;

    // A CLI can finish the image and then exit non-zero (or overrun the timeout
    // while wrapping up). The generated file is the requested result, so recover
    // the job instead of making API clients discard a valid image response.
    if (job.type === 'image' && imageFile && imageFile.size > 0 && status !== 'succeeded') {
      console.warn(`${tag} recovered generated image after CLI error: ${error}`);
      status = 'succeeded';
      error = null;
    }

    // Some CLIs exit 0 even when a denied tool call meant nothing was written.
    if (status === 'succeeded' && job.type === 'image' && !imageFile) {
      // stdout is the agent's final reply (e.g. why it declined); Codex's
      // stderr is its whole transcript, prompt included.
      const detail = (result.stdout.trim() || result.stderr.trim()).slice(-2000);
      status = 'failed';
      error = `The CLI finished without producing an image file${detail ? `: ${detail}` : ''}`;
    }

    let output = result.stdout.trim();
    let imageUrl = null;

    if (job.type === 'image' && imageFile) {
      imageUrl = imageFile.url;
      output = imageFile.url;
    }

    console.log(`${tag} ${status} in ${result.durationMs} ms${error ? `: ${error}` : ''}`);
    return finishJob(job.id, {
      status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output,
      outputTruncated: result.truncated,
      files,
      imageUrl,
      error,
    });
  } catch (error) {
    console.error(`${tag} internal error`, error);
    return finishJob(job.id, { status: 'failed', error: 'Internal error while running the CLI' });
  }
}

function findImageFile(files) {
  return files.find((file) => /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name));
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

const md5 = async (file) => createHash('md5').update(await readFile(file)).digest('hex');

/**
 * Drop output files that are byte-identical to one of the reference images.
 * Returning a reference as the generated image looks like success and is the
 * one failure a caller cannot spot from the API response.
 */
export async function dropInputCopies(files, images = [], tag = '') {
  if (!images.length || !files.length) return files;

  const bySize = new Map();
  for (const image of images) {
    if (!bySize.has(image.size)) bySize.set(image.size, []);
    bySize.get(image.size).push(image);
  }

  const kept = [];
  for (const file of files) {
    const candidates = bySize.get(file.size);
    if (!candidates) {
      kept.push(file);
      continue;
    }
    const hash = await md5(file.path).catch(() => null);
    let copied = null;
    for (const image of candidates) {
      image.hash ??= await md5(image.path).catch(() => null);
      if (hash && image.hash === hash) {
        copied = image;
        break;
      }
    }
    if (copied) console.warn(`${tag} ignoring ${file.name}: it is a copy of reference image "${copied.label}"`);
    else kept.push(file);
  }
  return kept;
}

/** Where each CLI parks images its own image tool produced. */
const GENERATED_IMAGE_DIRS = {
  codex: () => path.join(config.codexHome, 'generated_images'),
};

/**
 * Last resort for an image job that produced no file: look in the CLI's own
 * image output folder for something it made during this run and bring it into
 * the job directory. A generation that already cost time and quota should not
 * be thrown away because the agent forgot the final copy step.
 */
export async function rescueGeneratedImage(job, outputDir, sinceMs, tag) {
  const directory = GENERATED_IMAGE_DIRS[job.cli]?.();
  if (!directory) return null;

  let newest = null;
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !IMAGE_FILE.test(entry.name)) continue;
      const info = await stat(absolutePath).catch(() => null);
      // Only files this run produced - never an image from an earlier job.
      if (!info || info.mtimeMs < sinceMs || !info.size) continue;
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path: absolutePath, mtimeMs: info.mtimeMs };
    }
  };
  await visit(directory);
  if (!newest) return null;

  const name = `generated-${Date.now()}${path.extname(newest.path).toLowerCase()}`;
  try {
    // collectOutputFiles removes the directory when a run left nothing behind.
    await mkdir(outputDir, { recursive: true });
    await copyFile(newest.path, path.join(outputDir, name));
  } catch (error) {
    console.error(`${tag} could not recover ${newest.path}: ${error.message}`);
    return null;
  }
  console.warn(`${tag} recovered generated image the CLI left in ${path.dirname(newest.path)}`);
  return name;
}

export function killAllRunning() {
  for (const child of runningChildren) killProcessTree(child, 'SIGTERM');
}

// Streams CLI output to the server console as it arrives, one prefixed line at a time.
function logLines(tag, chunk) {
  for (const line of chunk.split('\n')) {
    if (line.trim()) console.log(`${tag} ${line}`);
  }
}

// File URLs are stored root-relative ("/outputs/<jobId>/<file>"); the base URL is only
// added when a response is sent, so a changed host, port or BASE_URL never breaks them.
async function collectOutputFiles(jobId, outputDir) {
  const entries = await readdir(outputDir, { recursive: true });
  const files = [];
  for (const relativePath of entries) {
    // Reference images are inputs, not results.
    if (relativePath === INPUTS_DIR || relativePath.startsWith(INPUTS_DIR + path.sep) || relativePath.startsWith(`${INPUTS_DIR}/`)) {
      continue;
    }
    const absolutePath = path.join(outputDir, relativePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) continue;
    files.push({
      name: relativePath,
      path: absolutePath,
      url: outputsUrl(path.join(jobId, relativePath)),
      size: info.size,
    });
  }

  // Text-only jobs usually produce no files; don't leave empty directories behind.
  if (files.length === 0) await rmdir(outputDir).catch(() => {});
  return files;
}

function killProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function describeFailure({ command, error, timedOut, timeoutMs, exitCode, signal, stderr }) {
  if (error?.code === 'ENOENT') return `CLI "${command}" is not installed or not on PATH`;
  if (error) return error.message;
  if (timedOut) return `Timed out after ${timeoutMs} ms`;
  const detail = stderr.trim().slice(-2000);
  if (detail) return detail;
  return signal ? `Killed by ${signal}` : `Exited with code ${exitCode}`;
}
