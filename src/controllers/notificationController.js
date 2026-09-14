import { CATEGORIES, Notification } from '../models/Notification.js';
import { broadcast, canSee, onShutdown, presentNotification, subscribe, visibleTo } from '../services/notifications.js';
import { objectId } from '../utils/validate.js';

const HEARTBEAT_MS = 25000;

// GET /api/notifications?unread=true&category=auth&limit=30&before=<iso>
export async function listNotifications(req, res) {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
  const visible = visibleTo(req.user);
  const filter = { ...visible };
  if (req.query.unread === 'true') filter.readBy = { $ne: req.user._id };
  if (CATEGORIES.includes(req.query.category)) filter.category = req.query.category;
  if (req.query.before) {
    const before = new Date(String(req.query.before));
    if (!Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };
  }

  const [items, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit + 1),
    Notification.countDocuments({ ...visible, readBy: { $ne: req.user._id } }),
  ]);
  res.json({
    notifications: items.slice(0, limit).map((item) => presentNotification(item, req.user._id)),
    unread,
    hasMore: items.length > limit,
  });
}

// POST /api/notifications/:id/read
export async function markRead(req, res) {
  await Notification.updateOne(
    { _id: objectId(req.params.id, 'Notification'), ...visibleTo(req.user) },
    { $addToSet: { readBy: req.user._id } },
  );
  broadcast('notifications-read', {}, { audience: 'user', user: req.user._id });
  res.status(204).end();
}

// POST /api/notifications/read-all
export async function markAllRead(req, res) {
  await Notification.updateMany(
    { ...visibleTo(req.user), readBy: { $ne: req.user._id } },
    { $addToSet: { readBy: req.user._id } },
  );
  broadcast('notifications-read', {}, { audience: 'user', user: req.user._id });
  res.status(204).end();
}

// GET /api/notifications/stream — Server-Sent Events: notification, agents, cron, notifications-read.
export function stream(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  const user = req.user;
  const unsubscribe = subscribe((event) => {
    if (!canSee(event, user)) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  const cancelShutdown = onShutdown(() => res.end());

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    cancelShutdown();
  });
}
