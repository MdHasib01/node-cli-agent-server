import { EventEmitter } from 'node:events';
import { Notification } from '../models/Notification.js';

// Fan-out to connected dashboards (Server-Sent Events, see notificationController.stream).
const bus = new EventEmitter();
bus.setMaxListeners(0);

/**
 * Stores a notification and pushes it live to every dashboard allowed to see it.
 * With `dedupeKey` + `dedupeMs`, nothing is raised if the same key was raised within that window.
 */
export async function notify({
  audience = 'all',
  user = null,
  severity = 'info',
  category = 'system',
  title,
  message = '',
  meta = {},
  dedupeKey = null,
  dedupeMs = 0,
}) {
  if (dedupeKey && dedupeMs > 0) {
    const recent = await Notification.exists({ dedupeKey, createdAt: { $gte: new Date(Date.now() - dedupeMs) } });
    if (recent) return null;
  }

  const notification = await Notification.create({
    audience,
    user,
    severity,
    category,
    title: String(title).slice(0, 200),
    message: String(message ?? '').slice(0, 2000),
    meta,
    dedupeKey,
  });
  bus.emit('event', {
    type: 'notification',
    audience,
    user: user ? String(user) : null,
    payload: presentNotification(notification, null),
  });
  return notification;
}

/** Pushes a live, non-persisted event (e.g. "agents changed") so dashboards refresh. */
export function broadcast(type, payload = {}, { audience = 'all', user = null } = {}) {
  bus.emit('event', { type, audience, user: user ? String(user) : null, payload });
}

export function subscribe(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

/** Asks every open event stream to end (used on shutdown so the HTTP server can close). */
export function closeStreams() {
  bus.emit('shutdown');
}

export function onShutdown(listener) {
  bus.once('shutdown', listener);
  return () => bus.off('shutdown', listener);
}

export function canSee(event, user) {
  if (event.audience === 'all') return true;
  if (event.audience === 'admins') return user.role === 'admin';
  return event.user === String(user._id);
}

/** MongoDB filter for the notifications a user may see. */
export function visibleTo(user) {
  const audiences = [{ audience: 'all' }, { audience: 'user', user: user._id }];
  if (user.role === 'admin') audiences.push({ audience: 'admins' });
  return { $or: audiences };
}

export function presentNotification(notification, userId) {
  const data = notification.toJSON();
  const readBy = (data.readBy ?? []).map(String);
  delete data.readBy;
  delete data.dedupeKey;
  return { ...data, read: userId ? readBy.includes(String(userId)) : false };
}
