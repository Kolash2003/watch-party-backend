import IORedis from 'ioredis';
import { serverConfig } from '../config';

// maxRetriesPerRequest: null is required by BullMQ workers
export const makeRedis = () => new IORedis(serverConfig.REDIS_URL, { maxRetriesPerRequest: null });
export const redis = makeRedis();
