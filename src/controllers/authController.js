import { config } from '../config.js';
import { User } from '../models/User.js';
import {
  SESSION_COOKIE,
  hashPassword,
  sessionCookieOptions,
  signSession,
  verifyPassword,
} from '../services/authService.js';
import { notify } from '../services/notifications.js';
import { HttpError } from '../utils/httpError.js';
import { emailField, passwordField, requiredString } from '../utils/validate.js';

// Compared against when the email is unknown, so both paths take the same time.
const DUMMY_HASH = await hashPassword('timing-equaliser');

// GET /api/auth/config
export async function authConfig(req, res) {
  const hasUsers = (await User.estimatedDocumentCount()) > 0;
  res.json({ hasUsers, allowRegistration: config.allowRegistration || !hasUsers });
}

// POST /api/auth/register — the first account becomes the administrator.
export async function register(req, res) {
  const body = req.body ?? {};
  const name = requiredString(body.name, 'name', { max: 80 });
  const email = emailField(body.email);
  const password = passwordField(body.password);

  const isFirstUser = (await User.estimatedDocumentCount()) === 0;
  if (!config.allowRegistration && !isFirstUser) {
    throw new HttpError(403, 'Registration is closed. Ask an administrator to create your account.');
  }
  if (await User.exists({ email })) throw new HttpError(409, 'An account with this email already exists');

  const user = await User.create({
    name,
    email,
    passwordHash: await hashPassword(password),
    role: isFirstUser ? 'admin' : 'user',
    lastLoginAt: new Date(),
  });

  if (!isFirstUser) {
    await notify({
      audience: 'admins',
      severity: 'info',
      category: 'system',
      title: 'New account registered',
      message: `${name} (${email}) created an account.`,
      meta: { userId: String(user._id) },
    });
  }

  startSession(res, user);
  res.status(201).json({ user });
}

// POST /api/auth/login
export async function login(req, res) {
  const body = req.body ?? {};
  const email = emailField(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  const user = await User.findOne({ email }).select('+passwordHash');
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) throw new HttpError(401, 'Invalid email or password');
  if (user.status !== 'active') throw new HttpError(403, 'This account is disabled');

  user.lastLoginAt = new Date();
  await user.save();
  startSession(res, user);
  res.json({ user });
}

// POST /api/auth/logout
export function logout(req, res) {
  const { maxAge, ...options } = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
  res.status(204).end();
}

// GET /api/auth/me
export function me(req, res) {
  res.json({ user: req.user });
}

// PATCH /api/auth/me — { name?, currentPassword?, newPassword? }
export async function updateProfile(req, res) {
  const body = req.body ?? {};
  const user = await User.findById(req.user._id).select('+passwordHash');

  if (body.name !== undefined) user.name = requiredString(body.name, 'name', { max: 80 });
  if (body.newPassword !== undefined) {
    const newPassword = passwordField(body.newPassword, 'newPassword');
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!(await verifyPassword(current, user.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
    user.passwordHash = await hashPassword(newPassword);
    // Signs out every other browser.
    user.sessionVersion += 1;
  }

  await user.save();
  startSession(res, user);
  res.json({ user });
}

function startSession(res, user) {
  res.cookie(SESSION_COOKIE, signSession(user), sessionCookieOptions());
}
