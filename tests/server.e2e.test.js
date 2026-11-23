import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { startServers } from '../src/server/index.js';

const rootDir = resolve(import.meta.dirname, '..');

test('HTTP server mounts quizzes, injects collector, enforces auth, and serves SPA Referer assets', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'watching-e2e-'));
  const quizzesDir = join(tempRoot, 'quizzes');
  const dataDir = join(tempRoot, 'data');

  await mkdir(join(quizzesDir, 'spa-app', 'assets'), { recursive: true });
  await writeFile(
    join(quizzesDir, 'spa-app', 'index.html'),
    '<!doctype html><html><head><title>SPA App</title><script src="/assets/bundle.js"></script></head><body><div id="root"></div></body></html>'
  );
  await writeFile(join(quizzesDir, 'spa-app', 'assets', 'bundle.js'), 'window.__SPA__=true;');
  await writeFile(join(quizzesDir, 'spa-app', 'data.json'), '{"ok":true}');
  await writeFile(join(quizzesDir, 'spa-app', 'quiz.config.json'), JSON.stringify({ title: 'SPA 测试' }));
  await copyFile(join(rootDir, 'tests', 'fixtures', 'form-survey.html'), join(quizzesDir, 'form-survey.html'));

  const { appServer } = await startServers({
    loadEnv: false,
    host: '127.0.0.1',
    port: 0,
    quizzesDir,
    dataDir,
    monitorPassword: 'secret-pass',
    registryCacheTtlMs: 0
  });

  const { port } = appServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Canonical trailing slash redirect for /q/spa-app -> /q/spa-app/
    const redirRes = await fetch(`${baseUrl}/q/spa-app`, { redirect: 'manual' });
    assert.equal(redirRes.status, 302);
    assert.equal(redirRes.headers.get('location'), '/q/spa-app/');

    // 2. Entry HTML has collector injected & root-relative /assets/ rewritten to /q/spa-app/assets/
    const htmlRes = await fetch(`${baseUrl}/q/spa-app/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('data-watching-collector="1"'));
    assert.ok(html.includes('data-quiz-id="spa-app"'));
    assert.ok(html.includes('src="/q/spa-app/assets/bundle.js"'));

    // 3. Static asset + Referer fallback for dynamic fetch('/data.json')
    const bundleRes = await fetch(`${baseUrl}/q/spa-app/assets/bundle.js`);
    assert.equal(bundleRes.status, 200);
    assert.equal(await bundleRes.text(), 'window.__SPA__=true;');

    const refererRes = await fetch(`${baseUrl}/data.json`, {
      headers: { Referer: `${baseUrl}/q/spa-app/` }
    });
    assert.equal(refererRes.status, 200);
    assert.deepEqual(await refererRes.json(), { ok: true });

    // 4. Sensitive config file & path traversal must be blocked
    const cfgRes = await fetch(`${baseUrl}/q/spa-app/quiz.config.json`);
    assert.equal(cfgRes.status, 404);

    const traversalStatus = await new Promise((resolveStatus, rejectStatus) => {
      import('node:http').then(({ default: http }) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/q/spa-app/..%2f..%2fpackage.json', method: 'GET' },
          res => {
            res.resume();
            resolveStatus(res.statusCode);
          }
        );
        req.on('error', rejectStatus);
        req.end();
      });
    });
    assert.ok(traversalStatus === 403 || traversalStatus === 404, `Expected 403/404, got ${traversalStatus}`);

    // 5. Collector script served cleanly
    const collectorRes = await fetch(`${baseUrl}/collector/collector.js`);
    assert.equal(collectorRes.status, 200);
    assert.match(collectorRes.headers.get('content-type') || '', /javascript/);

    // 6. Auth status & protected monitor endpoints
    const authRes = await fetch(`${baseUrl}/api/auth/status`);
    assert.deepEqual(await authRes.json(), { ok: true, authRequired: true, authenticated: false });

    const unauthGet = await fetch(`${baseUrl}/api/records`);
    assert.equal(unauthGet.status, 401);

    // 7. Public POST /api/records succeeds, authorized GET returns it
    const postRes = await fetch(`${baseUrl}/api/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        sessionId: 'e2e-session',
        quizId: 'form-survey',
        quizTitle: '生活方式综合问卷',
        status: 'completed',
        summary: { headline: '活力平衡型', score: '86/100' },
        answers: [{ key: 'q1', order: 1, question: '作息', answer: '早睡早起' }]
      })
    });
    assert.equal(postRes.status, 201);

    const authedGet = await fetch(`${baseUrl}/api/records`, {
      headers: { Authorization: 'Bearer secret-pass' }
    });
    assert.equal(authedGet.status, 200);
    const data = await authedGet.json();
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].summary.headline, '活力平衡型');
  } finally {
    await new Promise(done => appServer.close(done));
    await rm(tempRoot, { recursive: true, force: true });
  }
});
