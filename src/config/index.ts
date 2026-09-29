// This file contains all the basic configuration logic for the app server to work
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const serverConfig = {
    PORT: Number(process.env.PORT) || 3001,
    DATABASE_URL: process.env.DATABASE_URL!,
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    STORAGE_ROOT: path.resolve(process.env.STORAGE_ROOT || './storage'),
    WEB_ORIGIN: process.env.WEB_ORIGIN || 'http://localhost:3000',
    SESSION_SECRET: process.env.SESSION_SECRET || 'dev-secret-change-me',
    MAX_UPLOAD_BYTES: Number(process.env.MAX_UPLOAD_BYTES) || 5 * 1024 ** 3,
    USER_QUOTA_BYTES: Number(process.env.USER_QUOTA_BYTES) || 20 * 1024 ** 3,
};
