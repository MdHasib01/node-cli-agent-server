import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

const { ObjectId } = mongoose.Schema.Types;

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** One row per /api/generate request, written when it starts and updated when it finishes. */
const usageRecordSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', default: null },
    token: { type: ObjectId, ref: 'ApiToken', default: null },
    source: { type: String, enum: ['token', 'session', 'api_key'], required: true },
    cli: { type: String, required: true },
    model: { type: String, default: null },
    type: { type: String, default: 'text' },
    status: { type: String, enum: ['running', 'succeeded', 'failed', 'timed_out'], default: 'running' },
    durationMs: { type: Number, default: null },
    jobId: { type: String, required: true },
    error: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON },
);

usageRecordSchema.index({ cli: 1, createdAt: -1 });
usageRecordSchema.index({ user: 1, createdAt: -1 });
usageRecordSchema.index({ token: 1, createdAt: -1 });
usageRecordSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const UsageRecord = mongoose.model('UsageRecord', usageRecordSchema);
