import assert from 'node:assert/strict';
import test from 'node:test';
import { injectCollectorIntoHtml } from '../src/server/services/html-injector.js';

test('injectCollectorIntoHtml injects collector before </head> and rewrites local root-relative assets', () => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Demo</title>
  <link rel="stylesheet" href="/assets/main.css">
  <link rel="stylesheet" href="https://cdn.example.com/lib.css">
</head>
<body>
  <img src="/images/hero.png">
  <script src="/assets/app.js"></script>
  <script src="/api/ignored.js"></script>
</body>
</html>`;

  const quiz = {
    slug: 'demo',
    title: '演示测试',
    type: 'directory',
    mountPath: '/q/demo/',
    rootEntries: ['assets', 'images', 'index.html'],
    collector: { questionSelector: '.q-item' }
  };

  const out = injectCollectorIntoHtml(html, quiz);

  assert.match(out, /<script src="\/collector\/collector\.js" data-watching-collector="1" data-quiz-id="demo"/);
  assert.match(out, /data-quiz-config="\{&quot;questionSelector&quot;:&quot;\.q-item&quot;\}"/);
  assert.ok(out.indexOf('data-watching-collector') < out.indexOf('</head>'));
  assert.ok(out.includes('href="/q/demo/assets/main.css"'));
  assert.ok(out.includes('src="/q/demo/images/hero.png"'));
  assert.ok(out.includes('src="/q/demo/assets/app.js"'));
  // External URLs and reserved prefixes must remain untouched.
  assert.ok(out.includes('href="https://cdn.example.com/lib.css"'));
  assert.ok(out.includes('src="/api/ignored.js"'));

  // Idempotent: calling twice does not double-inject.
  const twice = injectCollectorIntoHtml(out, quiz);
  assert.equal((twice.match(/data-watching-collector/g) || []).length, 1);
});

test('injectCollectorIntoHtml respects collector.enabled === false and handles fragment HTML without </head>', () => {
  const disabledOut = injectCollectorIntoHtml('<html><head></head><body></body></html>', {
    slug: 'no-track',
    title: 'No Track',
    type: 'single-file',
    mountPath: '/q/no-track/',
    rootEntries: [],
    collector: { enabled: false }
  });
  assert.ok(!disabledOut.includes('data-watching-collector'));

  const fragmentOut = injectCollectorIntoHtml('<div>Minimal HTML</div>', {
    slug: 'mini',
    title: 'Mini',
    type: 'single-file',
    mountPath: '/q/mini/',
    rootEntries: [],
    collector: {}
  });
  assert.ok(fragmentOut.includes('data-watching-collector="1"'));
});
