// config/redis.js
import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
  enableAutoPipelining: true,
});

redis.on('error', (e) => console.error('[REDIS]', e?.message || e));

export default redis;
