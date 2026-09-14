import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDatabase() {
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is not set. Add your MongoDB connection string to server/.env.');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection;
}

export function disconnectDatabase() {
  return mongoose.disconnect();
}
