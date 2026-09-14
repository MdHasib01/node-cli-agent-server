import { ApiToken } from '../models/ApiToken.js';
import { UsageRecord } from '../models/UsageRecord.js';
import { User } from '../models/User.js';
import { generateApiToken } from '../services/authService.js';
import { SUPPORTED_CLIS, isSupportedCli } from '../services/cliMapper.js';
import { notify } from '../services/notifications.js';
import { HttpError } from '../utils/httpError.js';
import { objectId, optionalFutureDate, optionalPositiveInt, requiredString } from '../utils/validate.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUSES = ['active', 'expired', 'revoked'];

// GET /api/tokens?user=<id>&status=<status> — admins see every user's tokens.
export async function listTokens(req, res) {
  const filter = ownerScope(req);
  if (req.user.role === 'admin' && req.query.user) filter.user = objectId(String(req.query.user), 'User');
  if (STATUSES.includes(req.query.status)) filter.status = req.query.status;

  const tokens = await ApiToken.find(filter).sort({ createdAt: -1 }).populate('user', 'name email role status');
  const usage = tokens.length
    ? await UsageRecord.aggregate([
        { $match: { token: { $in: tokens.map((token) => token._id) }, createdAt: { $gte: new Date(Date.now() - DAY_MS) } } },
        { $group: { _id: '$token', count: { $sum: 1 } } },
      ])
    : [];
  const usageByToken = new Map(usage.map((row) => [String(row._id), row.count]));

  res.json({ tokens: tokens.map((token) => presentToken(token, usageByToken.get(String(token._id)) ?? 0)) });
}

// POST /api/tokens — { name, userId?, allowedClis?, dailyLimit?, expiresAt? }
// The secret is returned once and never again.
export async function createToken(req, res) {
  const body = req.body ?? {};
  const input = parseTokenInput(body, { creating: true });

  let owner = req.user;
  if (body.userId && body.userId !== String(req.user._id)) {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can create tokens for other users');
    owner = await User.findById(objectId(String(body.userId), 'User'));
    if (!owner) throw new HttpError(404, 'User not found');
  }
  if (owner.status !== 'active') throw new HttpError(400, 'Cannot create a token for a disabled user');

  const generated = generateApiToken();
  const token = await ApiToken.create({
    ...input,
    user: owner._id,
    tokenHash: generated.hash,
    prefix: generated.prefix,
    lastFour: generated.lastFour,
    createdBy: req.user._id,
  });

  if (!owner._id.equals(req.user._id)) {
    await notify({
      audience: 'user',
      user: owner._id,
      severity: 'info',
      category: 'token',
      title: `New API token "${token.name}"`,
      message: `${req.user.name} created an API token for you. Ask them for the secret; it is only shown once.`,
      meta: { tokenId: String(token._id) },
    });
  }

  await token.populate('user', 'name email role status');
  res.status(201).json({ token: presentToken(token, 0), secret: generated.secret });
}

// PATCH /api/tokens/:id — { name?, allowedClis?, dailyLimit?, expiresAt? }
export async function updateToken(req, res) {
  const token = await findToken(req);
  const input = parseTokenInput(req.body ?? {}, { creating: false });
  Object.assign(token, input);

  if ('expiresAt' in input) {
    token.expiryWarnedAt = null;
    // Extending an expired token brings it back; a revoked token stays revoked.
    if (token.status === 'expired' && (!token.expiresAt || token.expiresAt > new Date())) token.status = 'active';
  }
  await token.save();
  await token.populate('user', 'name email role status');
  res.json({ token: presentToken(token) });
}

// POST /api/tokens/:id/revoke
export async function revokeToken(req, res) {
  const token = await findToken(req);
  if (token.status !== 'revoked') {
    token.status = 'revoked';
    token.revokedAt = new Date();
    token.revokedReason = `Revoked by ${req.user.name}`;
    await token.save();

    if (!token.user._id.equals(req.user._id)) {
      await notify({
        audience: 'user',
        user: token.user._id,
        severity: 'warning',
        category: 'token',
        title: `API token "${token.name}" was revoked`,
        message: `${req.user.name} revoked it. Requests using it are now rejected.`,
        meta: { tokenId: String(token._id) },
      });
    }
  }
  res.json({ token: presentToken(token) });
}

// POST /api/tokens/:id/regenerate — replaces the secret; the old one stops working immediately.
export async function regenerateToken(req, res) {
  const token = await findToken(req);
  if (token.status === 'revoked') throw new HttpError(400, 'A revoked token cannot be regenerated. Create a new one instead.');
  if (token.status === 'expired' || (token.expiresAt && token.expiresAt <= new Date())) {
    throw new HttpError(400, 'This token has expired. Set a new expiry date before regenerating it.');
  }

  const generated = generateApiToken();
  token.set({ tokenHash: generated.hash, prefix: generated.prefix, lastFour: generated.lastFour });
  await token.save();
  res.json({ token: presentToken(token), secret: generated.secret });
}

// DELETE /api/tokens/:id
export async function deleteToken(req, res) {
  const token = await findToken(req);
  await token.deleteOne();
  res.status(204).end();
}

function ownerScope(req) {
  return req.user.role === 'admin' ? {} : { user: req.user._id };
}

async function findToken(req) {
  const token = await ApiToken.findOne({ _id: objectId(req.params.id, 'Token'), ...ownerScope(req) }).populate(
    'user',
    'name email role status',
  );
  if (!token) throw new HttpError(404, 'Token not found');
  return token;
}

function parseTokenInput(body, { creating }) {
  const input = {};
  if (creating || body.name !== undefined) input.name = requiredString(body.name, 'name', { max: 80 });
  if (body.allowedClis !== undefined) {
    if (!Array.isArray(body.allowedClis) || !body.allowedClis.every(isSupportedCli)) {
      throw new HttpError(400, `"allowedClis" must be a list of: ${SUPPORTED_CLIS.join(', ')}`);
    }
    input.allowedClis = [...new Set(body.allowedClis)];
  }
  if (body.dailyLimit !== undefined) input.dailyLimit = optionalPositiveInt(body.dailyLimit, 'dailyLimit', { max: 1_000_000 });
  if (body.expiresAt !== undefined) input.expiresAt = optionalFutureDate(body.expiresAt, 'expiresAt');
  return input;
}

function presentToken(token, usage24h) {
  const data = token.toJSON();
  // The reviewer job flips the stored status; report expiry as soon as it happens.
  if (data.status === 'active' && token.expiresAt && token.expiresAt <= new Date()) data.status = 'expired';
  return usage24h === undefined ? data : { ...data, usage24h };
}
