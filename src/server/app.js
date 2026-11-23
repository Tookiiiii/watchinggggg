import { join } from 'node:path';
import { isAuthRequired, isMonitorAuthorized } from './auth.js';
import { loadConfig } from './config.js';
import { handleQuizzesApi } from './routes/api-quizzes.js';
import { handleRecordsApi } from './routes/api-records.js';
import { handleQuizRequest, tryServeQuizAssetByReferer } from './routes/quiz-static.js';
import { QuizRegistry } from './services/quiz-registry.js';
import { createStorage } from './storage/index.js';
import {
  parseRequestUrl,
  safeResolvePath,
  send,
  sendJson,
  sendRedirect,
  streamStaticFile
} from './utils/http.js';

export function createAppContext(configOverrides = {}) {
  const config = loadConfig(configOverrides);
  const storage = configOverrides.storage || createStorage(config);
  const registry = configOverrides.registry || new QuizRegistry(config.quizzesDir, {
    cacheTtlMs: config.registryCacheTtlMs
  });
  return { config, storage, registry };
}

export async function serveCollectorScript(req, res, { config }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }
  try {
    const ok = await streamStaticFile(req, res, config.collectorPath);
    if (!ok) send(res, 404, 'Not Found');
  } catch {
    send(res, 404, 'Not Found');
  }
}

export async function serveMonitorAsset(req, res, rawSubPath, { config }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }

  const monitorDir = join(config.webDir, 'monitor');
  const relative = !rawSubPath || rawSubPath === '/' ? 'index.html' : rawSubPath.replace(/^\/+/, '');
  const target = safeResolvePath(monitorDir, relative);
  if (!target) {
    send(res, 403, 'Forbidden');
    return;
  }

  try {
    const ok = await streamStaticFile(req, res, target);
    if (!ok) send(res, 404, 'Not Found');
  } catch {
    send(res, 404, 'Not Found');
  }
}

export async function servePortalPage(req, res, { config, registry }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }

  if (config.defaultQuiz) {
    const quiz = await registry.get(config.defaultQuiz);
    if (quiz) {
      sendRedirect(res, quiz.mountPath, 302);
      return;
    }
  }

  const portalFile = join(config.webDir, 'portal', 'index.html');
  try {
    const ok = await streamStaticFile(req, res, portalFile);
    if (!ok) send(res, 404, 'Not Found');
  } catch {
    send(res, 404, 'Not Found');
  }
}

export function handleAuthStatusApi(req, res, { config, bypassAuth = false }) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, { Allow: 'GET' });
    return;
  }
  const required = !bypassAuth && isAuthRequired(config);
  sendJson(res, 200, {
    ok: true,
    authRequired: required,
    authenticated: isMonitorAuthorized(req, config, { bypassAuth })
  });
}

export function createAppHandler(context) {
  const { config, storage, registry } = context;

  return async function handleRequest(req, res) {
    const url = parseRequestUrl(req, `${config.host}:${config.port}`);
    const pathname = url.pathname;

    // 1. API endpoints
    if (pathname === '/api/records') {
      await handleRecordsApi(req, res, { config, storage });
      return;
    }
    if (pathname === '/api/quizzes') {
      await handleQuizzesApi(req, res, { config, registry, storage });
      return;
    }
    if (pathname === '/api/auth/status') {
      handleAuthStatusApi(req, res, { config });
      return;
    }

    // 2. Universal frontend collector SDK
    if (pathname === config.collectorUrl || pathname === '/collector.js') {
      await serveCollectorScript(req, res, { config });
      return;
    }

    // 3. Unified monitor dashboard (/monitor -> /monitor/)
    if (pathname === '/monitor' || pathname === '/monitor.html') {
      sendRedirect(res, '/monitor/', 302);
      return;
    }
    if (pathname.startsWith('/monitor/')) {
      await serveMonitorAsset(req, res, pathname.slice('/monitor/'.length), { config });
      return;
    }

    // 4. Auto-mounted quizzes (/q/<slug>/...)
    if (pathname === '/q' || pathname === '/q/') {
      sendRedirect(res, '/', 302);
      return;
    }
    if (pathname.startsWith('/q/')) {
      const handled = await handleQuizRequest(req, res, pathname, url.search, { config, registry });
      if (handled) return;
    }

    // 5. Root portal (or default quiz redirect)
    if (pathname === '/' || pathname === '/index.html') {
      await servePortalPage(req, res, { config, registry });
      return;
    }

    // 6. Fallback: serve root-relative assets requested dynamically by SPA quizzes (via Referer)
    const servedByReferer = await tryServeQuizAssetByReferer(req, res, pathname, { registry });
    if (servedByReferer) return;

    send(res, 404, 'Not Found');
  };
}

export function createMonitorOnlyHandler(context) {
  const { config, storage, registry } = context;

  return async function handleMonitorRequest(req, res) {
    const url = parseRequestUrl(req, `${config.host}:${config.monitorPort || config.port}`);
    const pathname = url.pathname;

    if (pathname === '/api/records') {
      await handleRecordsApi(req, res, { config, storage });
      return;
    }
    if (pathname === '/api/quizzes') {
      await handleQuizzesApi(req, res, { config, registry, storage });
      return;
    }
    if (pathname === '/api/auth/status') {
      handleAuthStatusApi(req, res, { config });
      return;
    }
    if (pathname.startsWith('/monitor/')) {
      await serveMonitorAsset(req, res, pathname.slice('/monitor/'.length), { config });
      return;
    }

    await serveMonitorAsset(req, res, pathname === '/' ? 'index.html' : pathname, { config });
  };
}
