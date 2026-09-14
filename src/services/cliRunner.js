import { spawn } from 'node:child_process';
import { mkdir, readdir, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { buildCommand } from './cliMapper.js';
import { finishJob, updateJob } from './jobStore.js';

const MAX_OUTPUT_CHARS = 5_000_000;
const KILL_GRACE_MS = 5000;

const runningChildren = new Set();

/**
 * Runs a command with spawn() (never a shell). Never rejects: spawn errors,
 * non-zero exits and timeouts are all reported in the resolved result.
 * `onOutput` receives stdout/stderr chunks as they arrive.
 */
export function runCommand({ command, args, cwd, timeoutMs = config.cliTimeout, onOutput }) {
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

      const ok = !error && !timedOut && exitCode === 0;
      resolve({
        ok,
        notFound: error?.code === 'ENOENT',
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
      child = spawn(command, args, {
        cwd,
        shell: false,
        // stdin closed: any interactive prompt the CLI still shows gets EOF instead of hanging.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so a timeout can kill the CLI together with its subprocesses.
        detached: process.platform !== 'win32',
        env: { ...process.env, NO_COLOR: '1' },
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
export async function runJob(job) {
  const outputDir = path.join(config.outputsDir, job.id);
  const tag = `[job ${job.id}]`;
  try {
    await mkdir(outputDir, { recursive: true });
    const { command, args } = buildCommand({ ...job, outputDir });

    updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() });
    console.log(`${tag} ${job.cli} (${job.model ?? 'default model'}) ${job.type}: started`);

    const result = await runCommand({
      command,
      args,
      cwd: outputDir,
      onOutput: (chunk) => logLines(tag, chunk),
    });
    const files = await collectOutputFiles(job.id, outputDir);
    let status = result.ok ? 'succeeded' : result.timedOut ? 'timed_out' : 'failed';
    let error = result.error;

    // Some CLIs exit 0 even when a denied tool call meant nothing was written.
    if (status === 'succeeded' && job.type === 'image' && files.length === 0) {
      const detail = (result.stderr.trim() || result.stdout.trim()).slice(-2000);
      status = 'failed';
      error = `The CLI finished without producing an image file${detail ? `: ${detail}` : ''}`;
    }

    console.log(`${tag} ${status} in ${result.durationMs} ms${error ? `: ${error}` : ''}`);
    return finishJob(job.id, {
      status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.stdout.trim(),
      outputTruncated: result.truncated,
      files,
      error,
    });
  } catch (error) {
    console.error(`${tag} internal error`, error);
    return finishJob(job.id, { status: 'failed', error: 'Internal error while running the CLI' });
  }
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

async function collectOutputFiles(jobId, outputDir) {
  const entries = await readdir(outputDir, { recursive: true });
  const files = [];
  for (const relativePath of entries) {
    const absolutePath = path.join(outputDir, relativePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) continue;
    files.push({
      name: relativePath,
      path: absolutePath,
      url: `/outputs/${jobId}/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`,
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
