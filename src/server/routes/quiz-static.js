import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { injectCollectorIntoHtml } from '../services/html-injector.js';
import { isHtmlFile, safeResolvePath, send, sendRedirect, streamStaticFile } from '../utils/http.js';

function decodePathSafe(rawPath) {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return null;
  }
}

async function serveHtmlWithInjection(req, res, filePath, quiz, config) {
  const html = await readFile(filePath, 'utf8');
  const injected = injectCollectorIntoHtml(html, quiz, {
    collectorUrl: config.collectorUrl,
    apiEndpoint: '/api/records'
  });

  const body = req.method === 'HEAD' ? '' : injected;
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(injected, 'utf8'),
    'Cache-Control': 'no-store'
  };
  res.writeHead(200, headers);
  res.end(body);
}

export async function handleQuizRequest(req, res, pathname, search, { config, registry }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return true;
  }

  const match = pathname.match(/^\/q\/([^/]+)(\/.*)?$/);
  if (!match) return false;

  const rawSlug = decodePathSafe(match[1]);
  const rawRest = match[2] !== undefined ? decodePathSafe(match[2]) : null;
  if (rawSlug === null || (match[2] !== undefined && rawRest === null)) {
    send(res, 400, 'Bad Request');
    return true;
  }

  const quiz = await registry.get(rawSlug);
  if (!quiz) {
    send(res, 404, 'Quiz Not Found');
    return true;
  }

  // Ensure canonical trailing slash so relative assets (./style.css, images/a.png) resolve cleanly.
  if (rawRest === null && !/\.html?$/i.test(rawSlug)) {
    sendRedirect(res, `${quiz.mountPath}${search || ''}`, 302);
    return true;
  }

  // Entry page request: /q/<slug>/ or /q/<slug>.html
  if (!rawRest || rawRest === '/' || (quiz.type === 'single-file' && rawRest === `/${quiz.entryFile}`)) {
    try {
      await serveHtmlWithInjection(req, res, quiz.entryPath, quiz, config);
    } catch {
      send(res, 404, 'Quiz Entry Not Found');
    }
    return true;
  }

  // Single-file quizzes do not expose arbitrary sibling files in quizzes/.
  if (quiz.type === 'single-file') {
    send(res, 404, 'Not Found');
    return true;
  }

  // Sub-asset inside a directory quiz.
  const relativeAsset = rawRest.replace(/^\/+/, '');
  if (basename(relativeAsset).toLowerCase() === 'quiz.config.json' || relativeAsset.split('/').some(seg => seg.startsWith('.'))) {
    send(res, 404, 'Not Found');
    return true;
  }

  const targetPath = safeResolvePath(quiz.rootDir, relativeAsset);
  if (!targetPath) {
    send(res, 403, 'Forbidden');
    return true;
  }

  try {
    const info = await stat(targetPath);
    if (info.isDirectory()) {
      const indexFile = safeResolvePath(targetPath, 'index.html');
      if (indexFile) {
        const indexInfo = await stat(indexFile).catch(() => null);
        if (indexInfo?.isFile()) {
          await serveHtmlWithInjection(req, res, indexFile, quiz, config);
          return true;
        }
      }
      send(res, 404, 'Not Found');
      return true;
    }

    if (isHtmlFile(targetPath)) {
      await serveHtmlWithInjection(req, res, targetPath, quiz, config);
      return true;
    }

    const served = await streamStaticFile(req, res, targetPath);
    if (!served) send(res, 404, 'Not Found');
  } catch {
    send(res, 404, 'Not Found');
  }

  return true;
}

export async function tryServeQuizAssetByReferer(req, res, pathname, { registry }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const referer = req.headers.referer;
  if (!referer) return false;

  let refUrl;
  try {
    refUrl = new URL(referer);
  } catch {
    return false;
  }

  const match = refUrl.pathname.match(/^\/q\/([^/]+)(?:\/|$)/);
  if (!match) return false;

  const slug = decodePathSafe(match[1]);
  if (!slug) return false;

  const quiz = await registry.get(slug);
  if (!quiz || quiz.type !== 'directory') return false;

  const decodedPath = decodePathSafe(pathname);
  if (!decodedPath) return false;
  const relativeAsset = decodedPath.replace(/^\/+/, '');
  if (!relativeAsset || basename(relativeAsset).toLowerCase() === 'quiz.config.json' || relativeAsset.split('/').some(seg => seg.startsWith('.'))) {
    return false;
  }

  const targetPath = safeResolvePath(quiz.rootDir, relativeAsset);
  if (!targetPath) return false;

  try {
    const info = await stat(targetPath);
    if (!info.isFile() || isHtmlFile(targetPath)) return false;
    return await streamStaticFile(req, res, targetPath);
  } catch {
    return false;
  }
}
