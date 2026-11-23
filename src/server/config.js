import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const defaultRootDir = resolve(currentDir, '../..');

function parseDotEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function loadDotEnvFiles(rootDir = defaultRootDir) {
  const candidates = ['.env', '.env.local'];
  for (const filename of candidates) {
    const fullPath = join(rootDir, filename);
    if (!existsSync(fullPath)) continue;
    try {
      const parsed = parseDotEnv(readFileSync(fullPath, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // Ignore unreadable env files so server still boots with process.env.
    }
  }
}

export function loadConfig(overrides = {}) {
  const rootDir = resolve(overrides.rootDir || defaultRootDir);
  if (overrides.loadEnv !== false) {
    loadDotEnvFiles(rootDir);
  }

  const env = { ...process.env, ...(overrides.env || {}) };
  const dataDir = resolve(overrides.dataDir || env.DATA_DIR || join(rootDir, 'data'));
  const quizzesDir = resolve(overrides.quizzesDir || env.QUIZZES_DIR || join(rootDir, 'quizzes'));
  const webDir = resolve(overrides.webDir || join(rootDir, 'src', 'web'));
  const collectorPath = resolve(overrides.collectorPath || join(rootDir, 'src', 'collector', 'collector.js'));

  const port = Number(overrides.port ?? env.PORT ?? env.APP_PORT ?? 3000);
  const monitorPortRaw = overrides.monitorPort ?? env.MONITOR_PORT;
  const monitorPort = monitorPortRaw !== undefined && monitorPortRaw !== '' && monitorPortRaw !== null
    ? Number(monitorPortRaw)
    : null;

  return {
    rootDir,
    dataDir,
    recordsFile: join(dataDir, 'records.jsonl'),
    quizzesDir,
    webDir,
    collectorPath,
    collectorUrl: '/collector/collector.js',
    host: overrides.host || env.HOST || '127.0.0.1',
    port: Number.isFinite(port) ? port : 3000,
    monitorPort: Number.isFinite(monitorPort) ? monitorPort : null,
    monitorPassword: overrides.monitorPassword ?? env.MONITOR_PASSWORD ?? '',
    defaultQuiz: (overrides.defaultQuiz ?? env.DEFAULT_QUIZ ?? '').trim(),
    maxRecords: Math.max(1, Number(overrides.maxRecords ?? env.MAX_RECORDS ?? 1000) || 1000),
    maxBodyBytes: Math.max(64 * 1024, Number(overrides.maxBodyBytes ?? env.MAX_BODY_BYTES ?? 2 * 1024 * 1024) || 2 * 1024 * 1024),
    storageDriver: (overrides.storageDriver ?? env.STORAGE_DRIVER ?? 'auto').toLowerCase(),
    redisUrl: overrides.redisUrl ?? env.UPSTASH_REDIS_REST_URL ?? '',
    redisToken: overrides.redisToken ?? env.UPSTASH_REDIS_REST_TOKEN ?? '',
    redisKeyPrefix: overrides.redisKeyPrefix ?? env.REDIS_KEY_PREFIX ?? 'watching',
    legacyRedisKey: overrides.legacyRedisKey ?? env.LEGACY_REDIS_KEY ?? 'asti:records',
    registryCacheTtlMs: overrides.registryCacheTtlMs ?? 500
  };
}
