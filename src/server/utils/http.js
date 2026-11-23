import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm'
};

export function getMimeType(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function isHtmlFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  return ext === '.html' || ext === '.htm';
}

export function send(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...extraHeaders
  };
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  res.writeHead(status, headers);
  res.end(body);
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8', extraHeaders);
}

export function sendRedirect(res, location, status = 302) {
  res.writeHead(status, {
    Location: location,
    'Cache-Control': 'no-store'
  });
  res.end();
}

export async function parseJsonBody(req, maxBodyBytes = 2 * 1024 * 1024) {
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && req.body !== null) return req.body;
    if (typeof req.body === 'string') {
      try {
        return req.body ? JSON.parse(req.body) : {};
      } catch {
        throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
      }
    }
  }

  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 100);
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim().slice(0, 100);
  }
  return String(req.socket?.remoteAddress || '').slice(0, 100);
}

export function safeResolvePath(baseDir, relativePath) {
  const normalizedBase = resolve(baseDir);
  const cleaned = String(relativePath || '').replace(/^\/+/, '');
  const target = resolve(normalizedBase, cleaned);
  if (target !== normalizedBase && !target.startsWith(normalizedBase + sep)) {
    return null;
  }
  return target;
}

export function parseRequestUrl(req, fallbackHost = '127.0.0.1') {
  const host = req.headers.host || fallbackHost;
  return new URL(req.url || '/', `http://${host}`);
}

export async function streamStaticFile(req, res, filePath, extraHeaders = {}) {
  const info = await stat(filePath);
  if (!info.isFile()) {
    return false;
  }
  res.writeHead(200, {
    'Content-Type': getMimeType(filePath),
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
}
