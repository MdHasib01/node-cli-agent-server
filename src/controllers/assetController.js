import { realpath, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { HttpError } from '../utils/httpError.js';
import { outputsUrl, publicOutputsUrl, resolveBaseUrl } from '../utils/url.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const MAX_ASSETS = 1000;

// GET /api/assets — persistent image inventory built from the protected output directory.
export async function listAssets(req, res) {
  const files = await scanImages(config.outputsDir);
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  const baseUrl = resolveBaseUrl(req);
  const assets = files.slice(0, MAX_ASSETS).map((file) => ({
    ...file,
    url: publicOutputsUrl(outputsUrl(file.relativePath), baseUrl),
  }));

  res.setHeader('Cache-Control', 'no-store');
  res.json({ assets, total: files.length, truncated: files.length > MAX_ASSETS });
}

// DELETE /api/assets/:id — permanently remove an image from the local output directory.
export async function deleteAsset(req, res) {
  const assetPath = await resolveAssetPath(req.params.id);

  try {
    await unlink(assetPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'Asset not found');
    throw error;
  }

  res.status(204).end();
}

async function resolveAssetPath(id) {
  if (typeof id !== 'string' || !id) throw new HttpError(404, 'Asset not found');

  // Asset ids always use URL-style separators, even when the server runs on Windows.
  // Reject every alternate or ambiguous path form before touching the filesystem.
  if (id.includes('\\') || id.includes('\0') || path.posix.isAbsolute(id)) {
    throw new HttpError(400, 'Invalid asset path');
  }
  const segments = id.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new HttpError(400, 'Invalid asset path');
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(segments.at(-1)).toLowerCase())) {
    throw new HttpError(400, 'Invalid asset type');
  }

  const candidate = path.resolve(config.outputsDir, ...segments);

  try {
    const [root, resolved] = await Promise.all([realpath(config.outputsDir), realpath(candidate)]);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new HttpError(400, 'Invalid asset path');
    }

    const info = await stat(candidate);
    if (!info.isFile()) throw new HttpError(404, 'Asset not found');
    return candidate;
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'Asset not found');
    throw error;
  }
}

async function scanImages(root) {
  const files = [];
  await visit(root, '');
  return files;

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });

    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith('.')) return;
        const relativePath = path.join(relativeDirectory, entry.name);
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath);
          return;
        }
        if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return;

        const info = await stat(absolutePath);
        const segments = relativePath.split(path.sep);
        files.push({
          id: relativePath.split(path.sep).join('/'),
          jobId: segments.length > 1 ? segments[0] : null,
          name: entry.name,
          relativePath: relativePath.split(path.sep).join('/'),
          extension: path.extname(entry.name).slice(1).toLowerCase(),
          size: info.size,
          createdAt: new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs).toISOString(),
          modifiedAt: info.mtime.toISOString(),
        });
      }),
    );
  }
}
