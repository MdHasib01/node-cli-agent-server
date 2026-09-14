import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

const { ObjectId } = mongoose.Schema.Types;

const apiTokenSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // Only a SHA-256 hash of the secret is stored; prefix + last four identify it in the UI.
    tokenHash: { type: String, required: true, unique: true, select: false },
    prefix: { type: String, required: true },
    lastFour: { type: String, required: true },
    // Empty list = every CLI is allowed.
    allowedClis: { type: [String], default: [] },
    // Requests per rolling 24 hours; null = unlimited.
    dailyLimit: { type: Number, default: null, min: 1 },
    expiresAt: { type: Date, default: null },
    status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active', index: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    lastUsedAt: { type: Date, default: null },
    lastUsedIp: { type: String, default: null },
    requestCount: { type: Number, default: 0 },
    // Set by the token reviewer once the owner was warned about the upcoming expiry.
    expiryWarnedAt: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON },
);

export const ApiToken = mongoose.model('ApiToken', apiTokenSchema);
