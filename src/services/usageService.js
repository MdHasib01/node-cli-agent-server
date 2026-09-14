import { ApiToken } from '../models/ApiToken.js';
import { UsageRecord } from '../models/UsageRecord.js';
import { notify } from './notifications.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FAILED = ['failed', 'timed_out'];

/** Written when a request starts so running requests count towards rate limits. */
export async function startUsage(job, auth) {
  const record = await UsageRecord.create({
    user: auth.user?._id ?? null,
    token: auth.token?._id ?? null,
    source: auth.source,
    cli: job.cli,
    model: job.model,
    type: job.type,
    jobId: job.id,
  });
  if (auth.token) await ApiToken.updateOne({ _id: auth.token._id }, { $inc: { requestCount: 1 } });
  return record;
}

export async function finishUsage(record, job) {
  await UsageRecord.updateOne(
    { _id: record._id },
    { $set: { status: job.status, durationMs: job.durationMs ?? null, error: job.error ? String(job.error).slice(0, 500) : null } },
  );
}

/** Requests still "running" at startup were cut off by the previous shutdown. */
export async function markInterruptedUsage() {
  await UsageRecord.updateMany(
    { status: 'running' },
    { $set: { status: 'failed', error: 'The server stopped before the request finished' } },
  );
}

/** Warns a token's owner as it approaches its daily request limit. */
export async function checkTokenQuota(token) {
  if (!token?.dailyLimit) return;
  const used = await UsageRecord.countDocuments({ token: token._id, createdAt: { $gte: new Date(Date.now() - DAY_MS) } });
  if (used < token.dailyLimit * 0.9) return;
  const full = used >= token.dailyLimit;
  await notify({
    audience: 'user',
    user: token.user?._id ?? token.user,
    severity: full ? 'critical' : 'warning',
    category: 'token',
    title: `API token "${token.name}" used ${used} of ${token.dailyLimit} daily requests`,
    message: full
      ? 'New requests are rejected until older ones fall out of the 24-hour window.'
      : 'It starts rejecting requests once the limit is reached.',
    meta: { tokenId: String(token._id) },
    dedupeKey: `token-quota:${token._id}:${full ? 'full' : 'warn'}`,
    dedupeMs: 12 * HOUR_MS,
  });
}

// --- analytics; `scope` is {} for admins or { user: <ObjectId> } ---

export async function getUsageOverview(scope) {
  const now = Date.now();
  const since24h = new Date(now - DAY_MS);
  const since48h = new Date(now - 2 * DAY_MS);

  const [totalsRows, previous24h, byCliRows] = await Promise.all([
    UsageRecord.aggregate([
      { $match: { ...scope, createdAt: { $gte: since24h } } },
      {
        $group: {
          _id: null,
          requests: { $sum: 1 },
          succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $in: ['$status', FAILED] }, 1, 0] } },
          avgDurationMs: { $avg: '$durationMs' },
        },
      },
    ]),
    UsageRecord.countDocuments({ ...scope, createdAt: { $gte: since48h, $lt: since24h } }),
    UsageRecord.aggregate([
      { $match: { ...scope, createdAt: { $gte: since24h } } },
      { $group: { _id: '$cli', requests: { $sum: 1 } } },
    ]),
  ]);

  const totals = totalsRows[0] ?? { requests: 0, succeeded: 0, failed: 0, avgDurationMs: null };
  const finished = totals.succeeded + totals.failed;
  return {
    requests24h: totals.requests,
    previous24h,
    succeeded24h: totals.succeeded,
    failed24h: totals.failed,
    successRate: finished ? totals.succeeded / finished : null,
    avgDurationMs: totals.avgDurationMs == null ? null : Math.round(totals.avgDurationMs),
    byCli: Object.fromEntries(byCliRows.map((row) => [row._id, row.requests])),
  };
}

/** Request counts per agent, bucketed by hour or day in the viewer's time zone. */
export async function getUsageTimeseries(scope, { from, unit, timezone }) {
  const rows = await UsageRecord.aggregate([
    { $match: { ...scope, createdAt: { $gte: from } } },
    {
      $group: {
        _id: { bucket: { $dateTrunc: { date: '$createdAt', unit, timezone } }, cli: '$cli' },
        requests: { $sum: 1 },
        failed: { $sum: { $cond: [{ $in: ['$status', FAILED] }, 1, 0] } },
      },
    },
    { $sort: { '_id.bucket': 1 } },
  ]);
  return rows.map((row) => ({ bucket: row._id.bucket, cli: row._id.cli, requests: row.requests, failed: row.failed }));
}

export async function getRecentUsage(scope, limit) {
  return UsageRecord.find(scope)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('user', 'name email')
    .populate('token', 'name prefix lastFour');
}
