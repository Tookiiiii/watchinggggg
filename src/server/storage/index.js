import { FileStorage } from './file-storage.js';
import { RedisStorage } from './redis-storage.js';

export function createStorage(config) {
  const wantsRedis =
    config.storageDriver === 'redis' ||
    (config.storageDriver === 'auto' && Boolean(config.redisUrl && config.redisToken));

  if (wantsRedis) {
    if (!config.redisUrl || !config.redisToken) {
      throw new Error('STORAGE_DRIVER=redis requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
    }
    return new RedisStorage({
      url: config.redisUrl,
      token: config.redisToken,
      maxRecords: config.maxRecords,
      keyPrefix: config.redisKeyPrefix,
      legacyKey: config.legacyRedisKey
    });
  }

  return new FileStorage(config.recordsFile, {
    maxRecords: config.maxRecords
  });
}
