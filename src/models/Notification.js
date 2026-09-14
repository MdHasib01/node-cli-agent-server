import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

const { Mixed, ObjectId } = mongoose.Schema.Types;

const RETENTION_SECONDS = 60 * 24 * 60 * 60;

export const SEVERITIES = ['info', 'success', 'warning', 'critical'];
export const CATEGORIES = ['auth', 'usage', 'token', 'cron', 'system'];

const notificationSchema = new mongoose.Schema(
  {
    // all: every signed-in user · admins: administrators only · user: one user (`user`)
    audience: { type: String, enum: ['all', 'admins', 'user'], required: true },
    user: { type: ObjectId, ref: 'User', default: null },
    severity: { type: String, enum: SEVERITIES, default: 'info' },
    category: { type: String, enum: CATEGORIES, default: 'system' },
    title: { type: String, required: true, maxlength: 200 },
    message: { type: String, default: '', maxlength: 2000 },
    meta: { type: Mixed, default: () => ({}) },
    dedupeKey: { type: String, default: null },
    readBy: { type: [ObjectId], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON, minimize: false },
);

notificationSchema.index({ audience: 1, user: 1, createdAt: -1 });
notificationSchema.index({ dedupeKey: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const Notification = mongoose.model('Notification', notificationSchema);
