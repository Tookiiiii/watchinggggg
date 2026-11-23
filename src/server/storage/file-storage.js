import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mergeRecordUpdate, upgradeStoredRecord } from '../services/record-normalizer.js';

export class FileStorage {
  constructor(recordsFile, options = {}) {
    this.recordsFile = recordsFile;
    this.maxRecords = options.maxRecords || 1000;
    this._queue = Promise.resolve();
  }

  getBackendInfo() {
    return {
      type: 'file',
      location: 'data/records.jsonl'
    };
  }

  _enqueue(task) {
    const next = this._queue.then(task, task);
    this._queue = next.catch(() => {});
    return next;
  }

  async _ensureFile() {
    await mkdir(dirname(this.recordsFile), { recursive: true });
    try {
      await stat(this.recordsFile);
    } catch {
      await writeFile(this.recordsFile, '', 'utf8');
    }
  }

  async _readAllUnlocked() {
    await this._ensureFile();
    const raw = await readFile(this.recordsFile, 'utf8');
    const byId = new Map();

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const upgraded = upgradeStoredRecord(parsed);
        if (upgraded) {
          byId.set(upgraded.id, upgraded);
        }
      } catch {
        // Skip malformed lines without failing the full read.
      }
    }

    return Array.from(byId.values()).sort((a, b) => {
      const timeA = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
      const timeB = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
      return timeB - timeA;
    });
  }

  async _writeAllUnlocked(records) {
    await this._ensureFile();
    const trimmed = records.slice(0, this.maxRecords);
    const content = trimmed.map(item => JSON.stringify(item)).join('\n') + (trimmed.length ? '\n' : '');
    const tmpFile = `${this.recordsFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tmpFile, content, 'utf8');
    try {
      await rename(tmpFile, this.recordsFile);
    } catch (error) {
      await unlink(tmpFile).catch(() => {});
      throw error;
    }
  }

  async upsertRecord(incoming) {
    return this._enqueue(async () => {
      const records = await this._readAllUnlocked();
      const idx = records.findIndex(
        item => item.quizId === incoming.quizId && item.sessionId && item.sessionId === incoming.sessionId
      );

      let saved;
      let created = false;
      if (idx !== -1) {
        saved = mergeRecordUpdate(records[idx], incoming);
        records.splice(idx, 1);
      } else {
        saved = incoming;
        created = true;
      }

      records.unshift(saved);
      await this._writeAllUnlocked(records);
      return { record: saved, created };
    });
  }

  async listRecords(filters = {}) {
    const records = await this._readAllUnlocked();
    return applyRecordFilters(records, filters);
  }

  async deleteRecord(id) {
    return this._enqueue(async () => {
      const records = await this._readAllUnlocked();
      const next = records.filter(item => item.id !== id);
      if (next.length === records.length) return false;
      await this._writeAllUnlocked(next);
      return true;
    });
  }

  async clearRecords(options = {}) {
    return this._enqueue(async () => {
      if (options.quizId) {
        const records = await this._readAllUnlocked();
        const remaining = records.filter(item => item.quizId !== options.quizId);
        const deleted = records.length - remaining.length;
        await this._writeAllUnlocked(remaining);
        return { deleted };
      }
      const existing = await this._readAllUnlocked();
      await this._writeAllUnlocked([]);
      return { deleted: existing.length };
    });
  }
}

export function applyRecordFilters(records, filters = {}) {
  let result = records;
  if (filters.quizId) {
    result = result.filter(item => item.quizId === filters.quizId);
  }
  if (filters.status && (filters.status === 'completed' || filters.status === 'in_progress')) {
    result = result.filter(item => item.status === filters.status);
  }
  if (filters.search) {
    const keyword = String(filters.search).trim().toLowerCase();
    if (keyword) {
      result = result.filter(item => JSON.stringify(item).toLowerCase().includes(keyword));
    }
  }
  if (filters.limit && Number.isFinite(Number(filters.limit)) && Number(filters.limit) > 0) {
    result = result.slice(0, Number(filters.limit));
  }
  return result;
}
