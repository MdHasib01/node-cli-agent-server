import { ApiToken } from '../models/ApiToken.js';
import { UsageRecord } from '../models/UsageRecord.js';
import { User } from '../models/User.js';
import { notify } from '../services/notifications.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 3;
const IDLE_DAYS = 30;
const QUOTA_WARNING_RATIO = 0.9;

/**
 * Reviews every API token:
 *  - expires tokens past their expiry date
 *  - revokes tokens whose owner was disabled
 *  - warns owners a few days before a token expires
 *  - warns owners whose token is close to its daily request limit
 *  - reports tokens nobody has used for a month
 */
export async function reviewTokens() {
  const now = new Date();

  const expired = await ApiToken.find({ status: 'active', expiresAt: { $ne: null, $lte: now } });
  for (const token of expired) {
    token.status = 'expired';
    await token.save();
    await notify({
      audience: 'user',
      user: token.user,
      severity: 'warning',
      category: 'token',
      title: `API token "${token.name}" expired`,
      message: 'Requests using it are now rejected. Extend it or generate a new token from the Tokens page.',
      meta: { tokenId: String(token._id) },
    });
  }

  const disabledOwners = await User.find({ status: 'disabled' }, { _id: 1 }).lean();
  const revoked = disabledOwners.length
    ? await ApiToken.updateMany(
        { status: 'active', user: { $in: disabledOwners.map((user) => user._id) } },
        { $set: { status: 'revoked', revokedAt: now, revokedReason: 'Owner account disabled' } },
      )
    : { modifiedCount: 0 };

  const expiringSoon = await ApiToken.find({
    status: 'active',
    expiresAt: { $gt: now, $lte: new Date(now.getTime() + EXPIRY_WARNING_DAYS * DAY_MS) },
    expiryWarnedAt: null,
  });
  for (const token of expiringSoon) {
    await notify({
      audience: 'user',
      user: token.user,
      severity: 'warning',
      category: 'token',
      title: `API token "${token.name}" expires soon`,
      message: `It stops working on ${token.expiresAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.`,
      meta: { tokenId: String(token._id), expiresAt: token.expiresAt },
    });
    token.expiryWarnedAt = now;
    await token.save();
  }

  const nearQuota = await tokensNearQuota(now);
  for (const { token, used } of nearQuota) {
    const full = used >= token.dailyLimit;
    await notify({
      audience: 'user',
      user: token.user,
      severity: full ? 'critical' : 'warning',
      category: 'token',
      title: `API token "${token.name}" used ${used} of ${token.dailyLimit} daily requests`,
      message: full ? 'New requests are rejected until older ones fall out of the 24-hour window.' : 'It is close to its daily limit.',
      meta: { tokenId: String(token._id) },
      dedupeKey: `token-quota:${token._id}:${full ? 'full' : 'warn'}`,
      dedupeMs: 12 * 60 * 60 * 1000,
    });
  }

  const idleCutoff = new Date(now.getTime() - IDLE_DAYS * DAY_MS);
  const idle = await ApiToken.countDocuments({
    status: 'active',
    $or: [{ lastUsedAt: { $lt: idleCutoff } }, { lastUsedAt: null, createdAt: { $lt: idleCutoff } }],
  });
  if (idle > 0) {
    await notify({
      audience: 'admins',
      severity: 'info',
      category: 'token',
      title: `${idle} API token${idle === 1 ? '' : 's'} unused for ${IDLE_DAYS}+ days`,
      message: 'Consider revoking tokens that are no longer needed.',
      meta: { idle },
      dedupeKey: 'token-idle',
      dedupeMs: DAY_MS,
    });
  }

  const active = await ApiToken.countDocuments({ status: 'active' });
  const details = {
    active,
    expired: expired.length,
    revoked: revoked.modifiedCount ?? 0,
    expiringSoon: expiringSoon.length,
    nearQuota: nearQuota.length,
    idle,
  };
  return {
    summary: `${active} active · ${details.expired} expired · ${details.revoked} revoked · ${details.expiringSoon} expiring soon · ${details.nearQuota} near quota · ${idle} idle`,
    details,
  };
}

async function tokensNearQuota(now) {
  const limited = await ApiToken.find({ status: 'active', dailyLimit: { $ne: null } });
  if (limited.length === 0) return [];
  const counts = await UsageRecord.aggregate([
    { $match: { token: { $in: limited.map((token) => token._id) }, createdAt: { $gte: new Date(now.getTime() - DAY_MS) } } },
    { $group: { _id: '$token', count: { $sum: 1 } } },
  ]);
  const used = new Map(counts.map((row) => [String(row._id), row.count]));
  return limited
    .map((token) => ({ token, used: used.get(String(token._id)) ?? 0 }))
    .filter(({ token, used: count }) => count >= token.dailyLimit * QUOTA_WARNING_RATIO);
}

export const TOKEN_REVIEW_JOB = {
  key: 'token-reviewer',
  name: 'API token review',
  description:
    'Expires tokens past their expiry date, revokes tokens of disabled users, warns owners before a token expires or runs out of daily quota, and flags tokens unused for 30 days.',
  run: reviewTokens,
};
