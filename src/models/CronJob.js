import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

/** Persisted settings and last-run state of a cron job defined in code (see services/cronManager.js). */
const cronJobSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    schedule: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    lastRunAt: { type: Date, default: null },
    lastStatus: { type: String, enum: ['success', 'failed', null], default: null },
    lastDurationMs: { type: Number, default: null },
    lastSummary: { type: String, default: null },
    lastError: { type: String, default: null },
    runCount: { type: Number, default: 0 },
    failCount: { type: Number, default: 0 },
  },
  { timestamps: true, toJSON },
);

export const CronJob = mongoose.model('CronJob', cronJobSchema);
