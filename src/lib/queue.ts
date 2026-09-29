import { Queue } from 'bullmq';
import { makeRedis } from './redis';

export const transcodeQueue = new Queue('transcode', { connection: makeRedis() });
