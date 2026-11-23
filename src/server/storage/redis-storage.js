import { mergeRecordUpdate, upgradeStoredRecord } from '../services/record-normalizer.js';
import { applyRecordFilters } from './file-storage.js';

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
}

export class RedisStorage {
  constructor(options = {}) {
    this._client = options.client || null;
    this._url = options.url;
    this._token = options.token;
    this.maxRecords = options.maxRecords || 1000;
    const prefix = options.keyPrefix || 'watching';
    this.dataKey = `${prefix}:records:data`;
    this.sessionKey = `${prefix}:records:sessions`;
    this.indexKey = `${prefix}:records:index`;
    this.legacyKey = options.legacyKey || 'asti:records';
  }

  async _getClient() {
    if (!this._client) {
      const { Redis } = await import('@upstash/redis');
      this._client = new Redis({
        url: this._url,
        token: this._token
      });
    }
    return this._client;
  }

  getBackendInfo() {
    return {
      type: 'redis',
      location: `${this.dataKey}`
    };
  }

  async upsertRecord(incoming) {
    const redis = await this._getClient();
    const sessionField = `${incoming.quizId}:${incoming.sessionId}`;
    const existingId = incoming.sessionId ? await redis.hget(this.sessionKey, sessionField) : null;

    let saved = incoming;
    let created = true;

    if (existingId) {
      const rawExisting = await redis.hget(this.dataKey, String(existingId));
      const parsed = upgradeStoredRecord(parseMaybeJson(rawExisting));
      if (parsed) {
        saved = mergeRecordUpdate(parsed, incoming);
        created = false;
      }
    }

    const score = Date.parse(saved.updatedAt || saved.createdAt || new Date().toISOString()) || Date.now();
    await Promise.all([
      redis.hset(this.dataKey, { [saved.id]: JSON.stringify(saved) }),
      redis.hset(this.sessionKey, { [sessionField]: saved.id }),
      redis.zadd(this.indexKey, { score, member: saved.id })
    ]);

    // Trim oldest entries if over maxRecords.
    const total = await redis.zcard(this.indexKey);
    if (total > this.maxRecords) {
      const excess = total - this.maxRecords;
      const staleIds = await redis.zrange(this.indexKey, 0, excess - 1);
      if (Array.isArray(staleIds) && staleIds.length > 0) {
        await Promise.all([
          redis.zrem(this.indexKey, ...staleIds),
          redis.hdel(this.dataKey, ...staleIds)
        ]);
      }
    }

    return { record: saved, created };
  }

  async _readAll() {
    const redis = await this._getClient();
    const ids = await redis.zrange(this.indexKey, 0, this.maxRecords - 1, { rev: true });
    const records = [];
    const seenIds = new Set();

    if (Array.isArray(ids) && ids.length > 0) {
      const rawMap = await redis.hmget(this.dataKey, ...ids);
      for (const id of ids) {
        const rawItem = Array.isArray(rawMap) ? rawMap[ids.indexOf(id)] : rawMap?.[id];
        const parsed = upgradeStoredRecord(parseMaybeJson(rawItem));
        if (parsed && !seenIds.has(parsed.id)) {
          seenIds.add(parsed.id);
          records.push(parsed);
        }
      }
    }

    // Transparently merge any legacy v1 ASTI records still stored under asti:records.
    if (this.legacyKey) {
      const legacyRows = await redis.lrange(this.legacyKey, 0, this.maxRecords - 1).catch(() => []);
      if (Array.isArray(legacyRows)) {
        for (const row of legacyRows) {
          const parsed = upgradeStoredRecord(parseMaybeJson(row));
          if (parsed && !seenIds.has(parsed.id)) {
            seenIds.add(parsed.id);
            records.push(parsed);
          }
        }
      }
    }

    return records.sort((a, b) => {
      const timeA = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
      const timeB = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
      return timeB - timeA;
    });
  }

  async listRecords(filters = {}) {
    const records = await this._readAll();
    return applyRecordFilters(records, filters);
  }

  async deleteRecord(id) {
    const redis = await this._getClient();
    const raw = await redis.hget(this.dataKey, id);
    const parsed = parseMaybeJson(raw);
    if (!parsed) return false;

    const tasks = [
      redis.hdel(this.dataKey, id),
      redis.zrem(this.indexKey, id)
    ];
    if (parsed.quizId && parsed.sessionId) {
      tasks.push(redis.hdel(this.sessionKey, `${parsed.quizId}:${parsed.sessionId}`));
    }
    await Promise.all(tasks);
    return true;
  }

  async clearRecords(options = {}) {
    const redis = await this._getClient();
    if (options.quizId) {
      const records = await this._readAll();
      const targets = records.filter(item => item.quizId === options.quizId);
      for (const item of targets) {
        await this.deleteRecord(item.id);
      }
      if (options.quizId === 'asti' && this.legacyKey) {
        await redis.del(this.legacyKey);
      }
      return { deleted: targets.length };
    }

    const keys = [this.dataKey, this.sessionKey, this.indexKey];
    if (this.legacyKey) keys.push(this.legacyKey);
    await redis.del(...keys);
    return { deleted: null };
  }
}
