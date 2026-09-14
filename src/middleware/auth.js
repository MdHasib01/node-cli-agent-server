import { timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { ApiToken } from '../models/ApiToken.js';
import { User } from '../models/User.js';
import { SESSION_COOKIE, TOKEN_PREFIX, hashApiToken, verifySession } from '../services/authService.js';
import { HttpError } from '../utils/httpError.js';

/** Dashboard routes: requires the session cookie set by /api/auth/login. */
export async function requireSession(req, res, next) {
  const user = await sessionUser(req);
  if (!user) throw new HttpError(401, 'Please sign in');
  req.user = user;
  req.auth = { source: 'session', user, token: null };
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'Administrator access required');
  next();
}

/**
 * CLI API routes. Accepts, in order:
 *  1. "Authorization: Bearer <token>" or "x-api-key: <token>" with a user API token (nak_...)
 *  2. the same headers with the legacy API_KEY from .env
 *  3. a dashboard session cookie
 * Sets req.auth = { source, user, token }.
 */
export async function requireApiAccess(req, res, next) {
  const provided = credentialFromHeaders(req);
  if (provided) {
    if (provided.startsWith(TOKEN_PREFIX)) {
      req.auth = await authenticateToken(provided, req);
      return next();
    }
    if (config.apiKey && safeEqual(provided, config.apiKey)) {
      req.auth = { source: 'api_key', user: null, token: null };
      return next();
    }
    throw new HttpError(401, 'Invalid API token');
  }

  const user = await sessionUser(req);
  if (user) {
    req.user = user;
    req.auth = { source: 'session', user, token: null };
    return next();
  }
  throw new HttpError(401, 'Unauthorized: send "Authorization: Bearer <api token>"');
}

async function authenticateToken(secret, req) {
  const token = await ApiToken.findOne({ tokenHash: hashApiToken(secret) }).populate('user');
  if (!token) throw new HttpError(401, 'Invalid API token');
  if (token.status === 'revoked') throw new HttpError(401, 'This API token has been revoked');
  if (token.status === 'expired' || (token.expiresAt && token.expiresAt <= new Date())) {
    throw new HttpError(401, 'This API token has expired');
  }
  if (!token.user || token.user.status !== 'active') {
    throw new HttpError(403, 'The owner of this API token is disabled');
  }

  ApiToken.updateOne({ _id: token._id }, { $set: { lastUsedAt: new Date(), lastUsedIp: req.ip ?? null } }).catch((error) =>
    console.error('[auth] could not record token use', error),
  );
  return { source: 'token', user: token.user, token };
}

async function sessionUser(req) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const payload = verifySession(raw);
  if (!payload?.sub || !mongoose.isValidObjectId(payload.sub)) return null;
  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active' || user.sessionVersion !== (payload.sv ?? 0)) return null;
  return user;
}

function credentialFromHeaders(req) {
  const authorization = req.get('authorization') ?? '';
  if (authorization.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim();
  return req.get('x-api-key')?.trim() ?? '';
}

function safeEqual(provided, expected) {
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
