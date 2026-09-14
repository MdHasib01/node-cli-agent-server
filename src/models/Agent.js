import mongoose from 'mongoose';
import { embedded, toJSON } from './plugins.js';

/** One usage window reported by the provider (e.g. Codex's 5-hour window) or measured locally. */
const windowSchema = new mongoose.Schema(
  {
    key: String,
    label: String,
    unit: { type: String, enum: ['percent', 'tokens'] },
    usedPercent: { type: Number, default: null },
    used: { type: Number, default: null },
    limit: { type: Number, default: null },
    windowMinutes: { type: Number, default: null },
    resetsAt: { type: Date, default: null },
    // The window has reset since the provider last reported it.
    stale: { type: Boolean, default: false },
  },
  embedded,
);

const providerSchema = new mongoose.Schema(
  {
    available: { type: Boolean, default: false },
    source: { type: String, default: null },
    plan: { type: String, default: null },
    reached: { type: String, default: null },
    note: { type: String, default: null },
    observedAt: { type: Date, default: null },
    checkedAt: { type: Date, default: null },
    windows: { type: [windowSchema], default: [] },
  },
  embedded,
);

const authSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['authenticated', 'unauthenticated', 'unknown'], default: 'unknown' },
    method: { type: String, default: null },
    detail: { type: String, default: null },
    // probe: the CLI's own sign-in status command · job: inferred from a request result
    source: { type: String, enum: ['probe', 'job', null], default: null },
    checkedAt: { type: Date, default: null },
    changedAt: { type: Date, default: null },
  },
  embedded,
);

/** Settings, limits and the latest health check of one whitelisted CLI agent. */
const agentSchema = new mongoose.Schema(
  {
    cli: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    limits: {
      requestsPerHour: { type: Number, default: null, min: 1 },
      requestsPerDay: { type: Number, default: null, min: 1 },
      maxConcurrent: { type: Number, default: null, min: 1 },
      // Token budgets turn locally measured token usage (Claude Code) into a percentage.
      tokenBudget5h: { type: Number, default: null, min: 1 },
      tokenBudget7d: { type: Number, default: null, min: 1 },
    },
    // Percentage of any limit at which a usage alert is raised.
    alertThreshold: { type: Number, default: 80, min: 1, max: 100 },
    installed: { type: Boolean, default: null },
    version: { type: String, default: null },
    auth: { type: authSchema, default: () => ({}) },
    provider: { type: providerSchema, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, toJSON, minimize: false },
);

export const Agent = mongoose.model('Agent', agentSchema);
