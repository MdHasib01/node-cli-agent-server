import mongoose from 'mongoose';
import { HttpError } from './httpError.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requiredString(value, field, { max = 200 } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `"${field}" is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `"${field}" must be at most ${max} characters`);
  return trimmed;
}

export function emailField(value) {
  const email = requiredString(value, 'email', { max: 254 }).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Enter a valid email address');
  return email;
}

export function passwordField(value, field = 'password') {
  if (typeof value !== 'string' || value.length < 8) throw new HttpError(400, `"${field}" must be at least 8 characters`);
  if (value.length > 200) throw new HttpError(400, `"${field}" must be at most 200 characters`);
  return value;
}

/** null for empty input, otherwise a whole number between 1 and `max`. */
export function optionalPositiveInt(value, field, { max = 1_000_000_000 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new HttpError(400, `"${field}" must be a whole number between 1 and ${max}`);
  }
  return number;
}

export function intInRange(value, field, min, max) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `"${field}" must be a whole number between ${min} and ${max}`);
  }
  return number;
}

/** null for empty input, otherwise a date in the future. */
export function optionalFutureDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new HttpError(400, `"${field}" must be a valid date`);
  if (date.getTime() <= Date.now()) throw new HttpError(400, `"${field}" must be in the future`);
  return date;
}

export function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw new HttpError(400, `"${field}" must be one of: ${allowed.join(', ')}`);
  return value;
}

/** Parses a route id; malformed ids are reported as "not found". */
export function objectId(value, what = 'Resource') {
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) throw new HttpError(404, `${what} not found`);
  return new mongoose.Types.ObjectId(value);
}
