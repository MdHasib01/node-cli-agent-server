import { ApiToken } from '../models/ApiToken.js';
import { Notification } from '../models/Notification.js';
import { UsageRecord } from '../models/UsageRecord.js';
import { User } from '../models/User.js';
import { hashPassword } from '../services/authService.js';
import { HttpError } from '../utils/httpError.js';
import { emailField, objectId, oneOf, passwordField, requiredString } from '../utils/validate.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLES = ['admin', 'user'];
const STATUSES = ['active', 'disabled'];

// GET /api/users
export async function listUsers(req, res) {
  const [users, tokenCounts, usageCounts] = await Promise.all([
    User.find().sort({ createdAt: 1 }),
    ApiToken.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$user', count: { $sum: 1 } } }]),
    UsageRecord.aggregate([
      { $match: { user: { $ne: null }, createdAt: { $gte: new Date(Date.now() - 30 * DAY_MS) } } },
      { $group: { _id: '$user', count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
    ]),
  ]);
  const tokens = new Map(tokenCounts.map((row) => [String(row._id), row.count]));
  const usage = new Map(usageCounts.map((row) => [String(row._id), row]));

  res.json({
    users: users.map((user) => ({
      ...user.toJSON(),
      activeTokens: tokens.get(String(user._id)) ?? 0,
      requests30d: usage.get(String(user._id))?.count ?? 0,
      lastRequestAt: usage.get(String(user._id))?.lastAt ?? null,
    })),
  });
}

// POST /api/users — { name, email, password, role? }
export async function createUser(req, res) {
  const body = req.body ?? {};
  const name = requiredString(body.name, 'name', { max: 80 });
  const email = emailField(body.email);
  const password = passwordField(body.password);
  const role = oneOf(body.role ?? 'user', 'role', ROLES);

  if (await User.exists({ email })) throw new HttpError(409, 'An account with this email already exists');
  const user = await User.create({ name, email, role, passwordHash: await hashPassword(password) });
  res.status(201).json({ user });
}

// PATCH /api/users/:id — { name?, role?, status?, password? }
export async function updateUser(req, res) {
  const user = await findUser(req);
  const body = req.body ?? {};
  const isSelf = user._id.equals(req.user._id);

  if (body.name !== undefined) user.name = requiredString(body.name, 'name', { max: 80 });

  if (body.role !== undefined) {
    const role = oneOf(body.role, 'role', ROLES);
    if (role !== 'admin' && user.role === 'admin') {
      if (isSelf) throw new HttpError(400, "You can't remove your own administrator role");
      await assertAnotherAdmin(user);
    }
    user.role = role;
  }

  if (body.status !== undefined) {
    const status = oneOf(body.status, 'status', STATUSES);
    if (status === 'disabled' && user.status !== 'disabled') {
      if (isSelf) throw new HttpError(400, "You can't disable your own account");
      if (user.role === 'admin') await assertAnotherAdmin(user);
      user.sessionVersion += 1;
      await ApiToken.updateMany(
        { user: user._id, status: 'active' },
        { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'Owner account disabled' } },
      );
    }
    user.status = status;
  }

  if (body.password !== undefined) {
    user.passwordHash = await hashPassword(passwordField(body.password));
    user.sessionVersion += 1;
  }

  await user.save();
  res.json({ user });
}

// DELETE /api/users/:id — also deletes the user's tokens and personal notifications.
export async function deleteUser(req, res) {
  const user = await findUser(req);
  if (user._id.equals(req.user._id)) throw new HttpError(400, "You can't delete your own account");
  if (user.role === 'admin') await assertAnotherAdmin(user);

  await Promise.all([
    ApiToken.deleteMany({ user: user._id }),
    Notification.deleteMany({ audience: 'user', user: user._id }),
  ]);
  await user.deleteOne();
  res.status(204).end();
}

async function findUser(req) {
  const user = await User.findById(objectId(req.params.id, 'User'));
  if (!user) throw new HttpError(404, 'User not found');
  return user;
}

async function assertAnotherAdmin(user) {
  const others = await User.countDocuments({ role: 'admin', status: 'active', _id: { $ne: user._id } });
  if (others === 0) throw new HttpError(400, 'At least one active administrator is required');
}
