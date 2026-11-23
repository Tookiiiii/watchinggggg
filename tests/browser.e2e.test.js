import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { startServers } from '../src/server/index.js';

const rootDir = resolve(import.meta.dirname, '..');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

const CHROME_BIN = CHROME_CANDIDATES.find(path => existsSync(path));

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function launchChrome() {
  const userDataDir = await mkdtemp(join(tmpdir(), 'watching-chrome-'));
  const proc = spawn(
    CHROME_BIN,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsUrl = await new Promise((resolveUrl, rejectUrl) => {
    let stderr = '';
    const timer = setTimeout(() => rejectUrl(new Error(`Chrome startup timeout: ${stderr}`)), 15000);
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    proc.once('exit', code => {
      clearTimeout(timer);
      rejectUrl(new Error(`Chrome exited early (${code}): ${stderr}`));
    });
  });

  const debugPort = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  assert.ok(pageTarget?.webSocketDebuggerUrl, 'Expected a Chrome page target');

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true });
    ws.addEventListener('error', rejectOpen, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const errors = [];

  ws.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params?.exceptionDetails?.text || 'Uncaught exception');
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  async function navigate(url) {
    const loaded = new Promise(resolveLoad => {
      const onMsg = event => {
        const msg = JSON.parse(String(event.data));
        if (msg.method === 'Page.loadEventFired') {
          ws.removeEventListener('message', onMsg);
          resolveLoad();
        }
      };
      ws.addEventListener('message', onMsg);
    });
    await send('Page.navigate', { url });
    await loaded;
    await sleep(150);
  }

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Browser eval failed: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async function close() {
    try { ws.close(); } catch { /* ignore */ }
    proc.kill('SIGKILL');
    await sleep(200);
    await rm(userDataDir, { recursive: true, force: true });
  }

  return { navigate, evaluate, close, errors };
}

async function waitForRecord(baseUrl, authToken, predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/records`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
    });
    const data = await res.json();
    const found = (data.records || []).find(predicate);
    if (found) return found;
    await sleep(150);
  }
  throw new Error('Timed out waiting for expected record in backend');
}

test('Real Chrome E2E: universal auto-collector captures unmodified ASTI, HTML Form, Auto-Advance SPA, and Monitor UI renders cleanly', { skip: !CHROME_BIN }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'watching-browser-'));
  const quizzesDir = join(tempRoot, 'quizzes');
  const dataDir = join(tempRoot, 'data');
  await mkdir(quizzesDir, { recursive: true });

  // Copy real unmodified ASTI + form survey + auto-advance SPA into quizzes/
  await cp(join(rootDir, 'quizzes', 'asti'), join(quizzesDir, 'asti'), { recursive: true });
  await copyFile(join(rootDir, 'tests', 'fixtures', 'form-survey.html'), join(quizzesDir, 'form-survey.html'));
  await copyFile(join(rootDir, 'tests', 'fixtures', 'spa-auto-advance.html'), join(quizzesDir, 'spa-auto-advance.html'));

  const password = 'e2e-password';
  const { appServer } = await startServers({
    loadEnv: false,
    host: '127.0.0.1',
    port: 0,
    quizzesDir,
    dataDir,
    monitorPassword: password,
    registryCacheTtlMs: 0
  });
  const { port } = appServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await launchChrome();

  try {
    // ---- Scenario 1: Unmodified ASTI (85 questions + go back and edit Q1 + full result card) ----
    await browser.navigate(`${baseUrl}/q/asti/`);
    const astiExpected = await browser.evaluate(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('#scr-start button').click();
      await wait(50);

      const q1Text = document.getElementById('q-text').textContent.trim();
      // Pick option 0 first, go to Q2, then go BACK to Q1 and change answer to option 4!
      document.querySelectorAll('#q-opts .opt-btn')[0].click();
      document.getElementById('btn-next').click();
      await wait(20);
      document.getElementById('btn-prev').click();
      await wait(20);
      document.querySelectorAll('#q-opts .opt-btn')[4].click();
      document.getElementById('btn-next').click();

      // Complete questions 2..85
      for (let i = 1; i < 85; i++) {
        const opts = document.querySelectorAll('#q-opts .opt-btn');
        opts[i % opts.length].click();
        document.getElementById('btn-next').click();
      }

      await wait(600);
      return {
        q1Text,
        resultCode: document.querySelector('.result-code')?.textContent?.trim() || '',
        resultName: document.querySelector('.result-name')?.textContent?.trim() || ''
      };
    })()`);

    const astiRecord = await waitForRecord(
      baseUrl,
      password,
      r => r.quizId === 'asti' && r.status === 'completed'
    );

    assert.equal(astiRecord.collectorMode, 'auto');
    assert.equal(astiRecord.answers.length, 85);
    assert.equal(astiRecord.totalQuestions, 85);
    assert.equal(astiRecord.answers[0].order, 1);
    assert.equal(astiRecord.answers[0].question, astiExpected.q1Text);
    assert.equal(astiRecord.answers[0].answer, '完全符合');
    assert.equal(astiRecord.answers[0].values[0], '4');
    assert.ok(astiRecord.answers[0].changeCount >= 2, 'Q1 modification via prev button should be tracked');
    assert.equal(astiRecord.summary.headline, astiExpected.resultCode);
    assert.equal(astiRecord.summary.title, astiExpected.resultName);
    assert.ok(astiRecord.summary.metrics.length >= 2, 'Expected extracted ASTI metrics (攻度/猎奇指数)');
    assert.ok(astiRecord.summary.text.includes('攻受分析'), 'Expected full ASTI result summary text');

    // ---- Scenario 2: Traditional HTML <form> (radio + multi checkbox + select + range + textarea) ----
    await browser.navigate(`${baseUrl}/q/form-survey/`);
    await browser.evaluate(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const sleepRadio = document.querySelector('input[name="sleep"][value="night"]');
      sleepRadio.click();

      document.querySelector('input[name="hobby"][value="game"]').click();
      document.querySelector('input[name="hobby"][value="hike"]').click();

      const drink = document.getElementById('drink');
      drink.value = 'coffee';
      drink.dispatchEvent(new Event('change', { bubbles: true }));

      const energy = document.getElementById('energy');
      energy.value = '85';
      energy.dispatchEvent(new Event('change', { bubbles: true }));

      const note = document.getElementById('note');
      note.value = '状态很棒';
      note.dispatchEvent(new Event('change', { bubbles: true }));

      await wait(50);
      document.querySelector('#survey-form button[type="submit"]').click();
      await wait(600);
    })()`);

    const formRecord = await waitForRecord(
      baseUrl,
      password,
      r => r.quizId === 'form-survey' && r.status === 'completed'
    );

    assert.equal(formRecord.answers.length, 5);
    const byType = Object.fromEntries(formRecord.answers.map(a => [a.inputType, a]));
    assert.equal(byType.radio.answer, '深夜猫头鹰');
    assert.deepEqual(byType.checkbox.selectedOptions, ['打游戏', '户外徒步']);
    assert.equal(byType.select.answer, '美式咖啡');
    assert.equal(byType.range.values[0], '85');
    assert.equal(byType.textarea.answer, '状态很棒');
    assert.equal(formRecord.summary.score, '86 / 100');
    assert.ok(formRecord.summary.badges.includes('高效休息'));
    assert.ok(formRecord.summary.metrics.some(m => m.label.includes('自律度') && m.value === 82));

    // ---- Scenario 3: Auto-advancing SPA with synchronous DOM swap on click ----
    await browser.navigate(`${baseUrl}/q/spa-auto-advance/`);
    await browser.evaluate(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      document.querySelectorAll('.choice-btn')[0].click(); // Q1: 立刻拆解方案
      await wait(30);
      document.querySelectorAll('.choice-btn')[1].click(); // Q2: 有点遗憾
      await wait(30);
      document.querySelectorAll('.choice-btn')[0].click(); // Q3: 深度专注单线推进 -> shows result
      await wait(600);
    })()`);

    const spaRecord = await waitForRecord(
      baseUrl,
      password,
      r => r.quizId === 'spa-auto-advance' && r.status === 'completed'
    );

    assert.equal(spaRecord.answers.length, 3);
    assert.equal(spaRecord.answers[0].question, '面对突发变化时，你的第一反应是？');
    assert.equal(spaRecord.answers[0].answer, '立刻拆解方案');
    assert.equal(spaRecord.answers[1].question, '周末聚会突然取消，你的真实感受是？');
    assert.equal(spaRecord.answers[1].answer, '有点遗憾');
    assert.equal(spaRecord.answers[2].question, '更喜欢哪种工作节奏？');
    assert.equal(spaRecord.answers[2].answer, '深度专注单线推进');
    assert.equal(spaRecord.summary.headline, 'INTJ');
    assert.equal(spaRecord.summary.title, '战略建筑师');
    assert.equal(spaRecord.summary.subtitle, '冷静洞察全局');

    // ---- Scenario 4: Monitor Dashboard UI login & rendering ----
    await browser.navigate(`${baseUrl}/monitor/`);
    const monitorState = await browser.evaluate(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const loginVisibleBefore = !document.getElementById('login-view').classList.contains('hidden');
      document.getElementById('password-input').value = '${password}';
      document.getElementById('login-submit').click();
      await wait(500);
      const appVisibleAfter = !document.getElementById('app-view').classList.contains('hidden');
      const quizChips = document.querySelectorAll('.quiz-chip').length;
      const recordItems = document.querySelectorAll('.record-item').length;
      const detailTitle = document.querySelector('.detail-title')?.textContent?.trim() || '';
      return { loginVisibleBefore, appVisibleAfter, quizChips, recordItems, detailTitle };
    })()`);

    assert.equal(monitorState.loginVisibleBefore, true);
    assert.equal(monitorState.appVisibleAfter, true);
    assert.equal(monitorState.quizChips, 4); // "全部测试" + 3 quizzes
    assert.equal(monitorState.recordItems, 3);
    assert.ok(monitorState.detailTitle.length > 0);
    assert.deepEqual(browser.errors, [], `Expected zero uncaught browser errors, got: ${browser.errors.join('; ')}`);
  } finally {
    await browser.close();
    await new Promise(done => appServer.close(done));
    await rm(tempRoot, { recursive: true, force: true });
  }
});
