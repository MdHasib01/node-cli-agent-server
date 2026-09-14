import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const SESSION_COOKIE = 'na_session';
export const TOKEN_PREFIX = 'nak_';

// Without JWT_SECRET sessions still work, but every restart signs everyone out.
const sessionSecret = config.jwtSecret || randomBytes(32).toString('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT_OPTIONS);
  return timingSafeEqual(actual, expected);
}

export function signSession(user) {
  return jwt.sign({ sub: String(user._id), sv: user.sessionVersion ?? 0 }, sessionSecret, {
    algorithm: 'HS256',
    expiresIn: `${config.sessionDays}d`,
  });
}

export function verifySession(token) {
  try {
    return jwt.verify(token, sessionSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
  };
}

/**
 * Creates a new API token secret. Only its SHA-256 hash is stored: the secret has
 * 240 bits of entropy, so a fast hash is enough and lets requests look it up directly.
 */
export function generateApiToken() {
  const secret = `${TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`;
  return { secret, hash: hashApiToken(secret), prefix: secret.slice(0, 8), lastFour: secret.slice(-4) };
}

export function hashApiToken(secret) {
  return createHash('sha256').update(secret).digest('hex');
}
