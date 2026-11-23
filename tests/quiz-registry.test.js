import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { QuizRegistry } from '../src/server/services/quiz-registry.js';

test('QuizRegistry auto-discovers directory quizzes, single HTML files, and hot additions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watching-registry-'));
  try {
    await mkdir(join(dir, 'folder-quiz'), { recursive: true });
    await writeFile(
      join(dir, 'folder-quiz', 'index.html'),
      '<!doctype html><html><head><title>文件夹测试</title><meta name="description" content="目录说明"></head><body>hi</body></html>'
    );
    await writeFile(join(dir, 'folder-quiz', 'app.js'), 'console.log(1);');

    await writeFile(
      join(dir, 'single-quiz.html'),
      '<!doctype html><html><head><title>单文件测试</title></head><body>ok</body></html>'
    );

    // Non-quiz files & empty directories should be ignored.
    await writeFile(join(dir, 'README.md'), '# ignore me');
    await mkdir(join(dir, 'empty-dir'), { recursive: true });

    const registry = new QuizRegistry(dir, { cacheTtlMs: 0 });
    const list = await registry.list();

    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map(q => ({ slug: q.slug, type: q.type, title: q.title, mountPath: q.mountPath })),
      [
        { slug: 'folder-quiz', type: 'directory', title: '文件夹测试', mountPath: '/q/folder-quiz/' },
        { slug: 'single-quiz', type: 'single-file', title: '单文件测试', mountPath: '/q/single-quiz/' }
      ]
    );
    assert.equal(list[0].description, '目录说明');
    assert.ok(list[0].rootEntries.includes('app.js'));

    // Hot drop a new Chinese-named HTML file with optional config without restarting registry.
    await writeFile(
      join(dir, 'mbti-快测.html'),
      '<!doctype html><html><head><title>原标题</title></head><body>mbti</body></html>'
    );
    await writeFile(
      join(dir, 'mbti-快测.config.json'),
      JSON.stringify({ title: '自定义MBTI标题', hidden: true })
    );

    const added = await registry.get('mbti-快测');
    assert.ok(added);
    assert.equal(added.title, '自定义MBTI标题');
    assert.equal(added.hidden, true);
    assert.equal(added.mountPath, `/q/${encodeURIComponent('mbti-快测')}/`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
