import { config } from '../config.js';

export const OUTPUTS_ROUTE = '/outputs';

/**
 * Resolves the public base URL of the server (e.g. "http://localhost:6000").
 * Uses config.baseUrl if set, otherwise deduces it from req, falling back to localhost:port.
 */
export function resolveBaseUrl(req) {
  if (config.baseUrl) return config.baseUrl;
  if (req) {
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    if (host) return `${proto}://${host}`.replace(/\/+$/, '');
  }
  return `http://localhost:${config.port}`;
}

/**
 * Root-relative URL of a file inside the outputs directory, e.g. "/outputs/<jobId>/image.png".
 * `relativePath` is relative to config.outputsDir and may use either path separator.
 * This is the only form that is stored, so it never depends on where the server runs.
 */
export function outputsUrl(relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent);
  return `${OUTPUTS_ROUTE}/${segments.join('/')}`;
}

/**
 * Turns a stored outputs URL into a full URL on the current base. Older absolute URLs
 * (from a previous host, port or BASE_URL) are re-pointed at the current base too.
 */
export function publicOutputsUrl(url, baseUrl) {
  if (typeof url !== 'string' || !url) return url;
  const index = url.indexOf(`${OUTPUTS_ROUTE}/`);
  if (index === -1) return url;
  const base = (baseUrl || resolveBaseUrl()).replace(/\/+$/, '');
  return `${base}${url.slice(index)}`;
}

/**
 * Returns a copy of the job with every outputs URL made absolute for the given base.
 * The stored job keeps its relative URLs.
 */
export function ensureAbsoluteJobUrls(job, baseUrl) {
  if (!job) return job;
  const base = (baseUrl || resolveBaseUrl()).replace(/\/+$/, '');
  const result = { ...job };

  if (Array.isArray(job.files)) {
    result.files = job.files.map((file) => ({ ...file, url: publicOutputsUrl(file.url, base) }));
  }
  if (job.imageUrl) result.imageUrl = publicOutputsUrl(job.imageUrl, base);

  // Image jobs answer with the image URL itself.
  if (job.type === 'image' && result.files?.length) {
    const imageFile = result.files.find((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)) || result.files[0];
    if (imageFile) {
      result.imageUrl = imageFile.url;
      if (!job.output || job.output.startsWith(OUTPUTS_ROUTE) || !job.output.startsWith('http')) {
        result.output = imageFile.url;
      }
    }
  }

  return result;
}
