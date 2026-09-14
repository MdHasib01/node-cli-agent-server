import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

const { Mixed, ObjectId } = mongoose.Schema.Types;

const RETENTION_SECONDS = 30 * 24 * 60 * 60;

const cronRunSchema = new mongoose.Schema(
  {
    job: { type: String, required: true },
    trigger: { type: String, enum: ['scheduled', 'manual', 'startup'], required: true },
    triggeredBy: { type: ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['running', 'success', 'failed'], default: 'running' },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    summary: { type: String, default: null },
    details: { type: Mixed, default: null },
    error: { type: String, default: null },
  },
  { toJSON },
);

cronRunSchema.index({ job: 1, startedAt: -1 });
cronRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const CronRun = mongoose.model('CronRun', cronRunSchema);
