import { ApiToken } from '../models/ApiToken.js';
import { User } from '../models/User.js';
import { getRecentUsage, getUsageOverview, getUsageTimeseries } from '../services/usageService.js';
import { HttpError } from '../utils/httpError.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 32 * DAY_MS;

// Admins see everything; other users only their own requests and tokens.
function scopeFor(req) {
  return req.user.role === 'admin' ? {} : { user: req.user._id };
}

// GET /api/stats/overview
export async function getOverview(req, res) {
  const scope = scopeFor(req);
  const isAdmin = req.user.role === 'admin';
  const [usage, activeTokens, expiringTokens, users] = await Promise.all([
    getUsageOverview(scope),
    ApiToken.countDocuments({ ...scope, status: 'active' }),
    ApiToken.countDocuments({ ...scope, status: 'active', expiresAt: { $ne: null, $lte: new Date(Date.now() + 7 * DAY_MS) } }),
    isAdmin ? User.countDocuments() : null,
  ]);
  res.json({ scope: isAdmin ? 'all' : 'mine', ...usage, activeTokens, expiringTokens, users });
}

// GET /api/stats/timeseries?from=<iso>&unit=hour|day&tz=<IANA zone>
export async function getTimeseries(req, res) {
  const unit = req.query.unit === 'day' ? 'day' : 'hour';
  const from = new Date(String(req.query.from ?? ''));
  if (Number.isNaN(from.getTime()) || Date.now() - from.getTime() > MAX_RANGE_MS) {
    throw new HttpError(400, '"from" must be a date within the last 32 days');
  }
  const timezone = validTimeZone(req.query.tz);
  res.json({ unit, from, timezone, series: await getUsageTimeseries(scopeFor(req), { from, unit, timezone }) });
}

// GET /api/stats/recent?limit=10
export async function getRecent(req, res) {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 50);
  res.json({ requests: await getRecentUsage(scopeFor(req), limit) });
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}
