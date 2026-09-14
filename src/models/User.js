import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'user'], default: 'user' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    // Bumped on password change or disable so existing session cookies stop working.
    sessionVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON },
);

export const User = mongoose.model('User', userSchema);
