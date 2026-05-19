import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(__dirname, 'public');
const dataDir = resolve(__dirname, 'data');
const recordsFile = join(dataDir, 'records.jsonl');

const host = process.env.HOST || '127.0.0.1';
const appPort = Number(process.env.APP_PORT || 3000);
const monitorPort = Number(process.env.MONITOR_PORT || 3002);
const maxBodyBytes = 1024 * 1024;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

await mkdir(dataDir, { recursive: true });
try {
  await stat(recordsFile);
} catch {
  await writeFile(recordsFile, '', 'utf8');
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  };
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function parseJsonBody(req) {
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
      chunks.push(chunk);
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

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function scrubText(value, maxLength = 4000) {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLength);
}

function normalizeAnswerRecord(body, req) {
  const result = body && typeof body.result === 'object' ? body.result : {};
  const scores = body && typeof body.scores === 'object' ? body.scores : {};
  const analysis = body && typeof body.analysis === 'object' ? body.analysis : {};
  const answers = body && typeof body.answers === 'object' ? body.answers : {};
  const questions = Array.isArray(body?.questions) ? body.questions.slice(0, 120) : [];

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    userAgent: scrubText(req.headers['user-agent'] || '', 500),
    ip: getClientIp(req),
    result: {
      code: scrubText(result.code, 20),
      cn: scrubText(result.cn, 80),
      en: scrubText(result.en, 80),
      slogan: scrubText(result.slogan, 200),
      desc: scrubText(result.desc, 1200)
    },
    scores,
    analysis: {
      roleLabel: scrubText(analysis.roleLabel, 80),
      atkPct: Number.isFinite(Number(analysis.atkPct)) ? Number(analysis.atkPct) : null,
      orientBrief: scrubText(analysis.orientBrief, 200),
      kinkLvBrief: scrubText(analysis.kinkLvBrief, 200),
      kinkSubs: Array.isArray(analysis.kinkSubs) ? analysis.kinkSubs.map(x => scrubText(x, 100)).slice(0, 50) : []
    },
    answers,
    questions: questions.map(q => ({
      order: Number.isFinite(Number(q.order)) ? Number(q.order) : null,
      index: Number.isFinite(Number(q.index)) ? Number(q.index) : null,
      text: scrubText(q.text, 500),
      answer: Number.isFinite(Number(q.answer)) ? Number(q.answer) : null,
      answerLabel: scrubText(q.answerLabel, 50)
    }))
  };
}

async function readRecords() {
  const text = await readFile(recordsFile, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

async function handleApp(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${appPort}`}`);

  if (req.method === 'POST' && url.pathname === '/api/records') {
    try {
      const body = await parseJsonBody(req);
      const record = normalizeAnswerRecord(body, req);
      await appendFile(recordsFile, `${JSON.stringify(record)}\n`, 'utf8');
      sendJson(res, 201, { ok: true, id: record.id });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message || 'Failed to save record' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }

  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const normalizedPath = normalize(relativePath);
  const filePath = resolve(publicDir, normalizedPath);

  if (filePath !== publicDir && !filePath.startsWith(publicDir + sep)) {
    send(res, 403, 'Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      send(res, 404, 'Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    createReadStream(filePath).pipe(res);
  } catch {
    send(res, 404, 'Not Found');
  }
}

function monitorHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ASTI 监控后台</title>
<style>
:root{color-scheme:dark;--bg:#08090f;--panel:#12141f;--panel2:#191b29;--text:#ebeaf3;--sub:#9a9aae;--line:rgba(255,255,255,.08);--red:#c24355;--purple:#9850c8;--gold:#c2a058;--green:#4aa882}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;line-height:1.55}.shell{max-width:1180px;margin:0 auto;padding:24px}.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:18px}.title h1{font-size:26px;margin:0 0 4px}.title p{margin:0;color:var(--sub);font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap}button{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:8px;padding:9px 12px;cursor:pointer}button:hover{border-color:var(--red)}.danger{color:#ffd8de;border-color:rgba(194,67,85,.35)}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}.stat b{display:block;font-size:22px}.stat span{color:var(--sub);font-size:12px}.grid{display:grid;grid-template-columns:340px 1fr;gap:14px}.list,.detail{background:var(--panel);border:1px solid var(--line);border-radius:8px;min-height:560px;overflow:hidden}.list-head{padding:12px;border-bottom:1px solid var(--line)}input{width:100%;border:1px solid var(--line);background:#0d0e16;color:var(--text);border-radius:8px;padding:10px}.records{max-height:640px;overflow:auto}.record{width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;text-align:left;padding:12px;display:block}.record.active{background:rgba(152,80,200,.13)}.record .code{color:var(--gold);font-weight:800;letter-spacing:1px}.record .meta{color:var(--sub);font-size:12px;margin-top:3px}.detail{padding:18px;overflow:auto}.empty{height:100%;display:flex;align-items:center;justify-content:center;color:var(--sub)}.badge{display:inline-flex;padding:4px 10px;border-radius:999px;background:rgba(194,67,85,.14);color:#ffb7c2;font-size:12px;margin:0 6px 6px 0}.scores{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:14px 0}.score{background:var(--panel2);border-radius:8px;padding:10px}.score small{color:var(--sub);display:block}.bar{height:6px;background:#0d0e16;border-radius:999px;margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--red),var(--purple),var(--gold))}.answers{border-collapse:collapse;width:100%;font-size:13px;margin-top:14px}.answers th,.answers td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}.answers th{color:var(--sub);font-weight:500}.answers td:first-child{color:var(--sub);width:52px}.notice{color:var(--sub);font-size:12px;margin-top:12px}@media(max-width:860px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}.scores{grid-template-columns:repeat(2,minmax(0,1fr))}.top{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body>
<main class="shell">
  <div class="top">
    <div class="title">
      <h1>ASTI 监控后台</h1>
      <p>本页显示本机服务收到的答题记录。应用页：<a href="http://${host}:${appPort}/" style="color:var(--gold)">http://${host}:${appPort}/</a></p>
    </div>
    <div class="actions">
      <button id="refresh">刷新</button>
      <button class="danger" id="clear">清空记录</button>
    </div>
  </div>
  <section class="stats">
    <div class="stat"><b id="total">0</b><span>总记录</span></div>
    <div class="stat"><b id="today">0</b><span>今日记录</span></div>
    <div class="stat"><b id="latest">-</b><span>最近类型</span></div>
    <div class="stat"><b id="updated">-</b><span>最后更新</span></div>
  </section>
  <section class="grid">
    <aside class="list">
      <div class="list-head"><input id="search" placeholder="搜索类型、题目、答案"></div>
      <div class="records" id="records"></div>
    </aside>
    <section class="detail" id="detail"><div class="empty">暂无记录</div></section>
  </section>
</main>
<script>
const dimNames = {D:'支配倾向',O:'开放程度',K:'猎奇指数',R:'浪漫需求',L:'欲望强度',E:'表现欲望',F:'幻想倾向',A:'情感依恋',G:'性别弹性',T:'道具兴趣'};
let records = [];
let selectedId = null;

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt = iso => iso ? new Date(iso).toLocaleString() : '-';

async function loadRecords(){
  const res = await fetch('/api/records', { cache: 'no-store' });
  const data = await res.json();
  records = data.records || [];
  if(!selectedId && records[0]) selectedId = records[0].id;
  render();
}

function filteredRecords(){
  const q = $('search').value.trim().toLowerCase();
  if(!q) return records;
  return records.filter(r => JSON.stringify(r).toLowerCase().includes(q));
}

function renderStats(list){
  const todayKey = new Date().toDateString();
  $('total').textContent = records.length;
  $('today').textContent = records.filter(r => new Date(r.createdAt).toDateString() === todayKey).length;
  $('latest').textContent = records[0]?.result?.code || '-';
  $('updated').textContent = new Date().toLocaleTimeString();
}

function renderList(list){
  $('records').innerHTML = list.map(r => \`
    <button class="record \${r.id === selectedId ? 'active' : ''}" data-id="\${esc(r.id)}">
      <div><span class="code">\${esc(r.result?.code || '-')}</span> \${esc(r.result?.cn || '')}</div>
      <div class="meta">\${esc(fmt(r.createdAt))} · \${esc(r.analysis?.roleLabel || '-')} · \${esc(r.analysis?.orientBrief || '-')}</div>
    </button>
  \`).join('') || '<div class="empty" style="min-height:220px">没有匹配记录</div>';
}

function renderDetail(){
  const r = records.find(item => item.id === selectedId);
  if(!r){
    $('detail').innerHTML = '<div class="empty">暂无记录</div>';
    return;
  }

  const scores = Object.entries(r.scores || {}).map(([key, value]) => \`
    <div class="score">
      <small>\${esc(dimNames[key] || key)}</small>
      <strong>\${esc(value)}</strong>
      <div class="bar"><i style="width:\${Math.max(0, Math.min(100, Number(value) || 0))}%"></i></div>
    </div>
  \`).join('');

  const answers = (r.questions || []).map(q => \`
    <tr>
      <td>\${esc(q.order)}</td>
      <td>\${esc(q.text)}</td>
      <td>\${esc(q.answerLabel)} <span style="color:var(--sub)">(\${esc(q.answer)})</span></td>
    </tr>
  \`).join('');

  $('detail').innerHTML = \`
    <h2 style="margin:0 0 4px">\${esc(r.result?.code || '-')} · \${esc(r.result?.cn || '')} <span style="color:var(--sub);font-size:16px">\${esc(r.result?.en || '')}</span></h2>
    <p style="margin:0 0 10px;color:var(--gold)">\${esc(r.result?.slogan || '')}</p>
    <span class="badge">\${esc(r.analysis?.roleLabel || '-')} / 攻度 \${esc(r.analysis?.atkPct ?? '-')}%</span>
    <span class="badge">\${esc(r.analysis?.orientBrief || '-')}</span>
    <span class="badge">\${esc(r.analysis?.kinkLvBrief || '-')}</span>
    \${(r.analysis?.kinkSubs || []).map(x => \`<span class="badge">\${esc(x)}</span>\`).join('')}
    <p style="color:var(--sub);font-size:13px">提交时间：\${esc(fmt(r.createdAt))} · IP：\${esc(r.ip || '-')}</p>
    <p style="color:var(--sub)">\${esc(r.result?.desc || '')}</p>
    <div class="scores">\${scores}</div>
    <h3>答题明细</h3>
    <table class="answers">
      <thead><tr><th>#</th><th>题目</th><th>回答</th></tr></thead>
      <tbody>\${answers}</tbody>
    </table>
    <p class="notice">原始记录文件：data/records.jsonl</p>
  \`;
}

function render(){
  const list = filteredRecords();
  renderStats(list);
  renderList(list);
  if(!records.some(r => r.id === selectedId) && records[0]) selectedId = records[0].id;
  renderDetail();
}

$('records').addEventListener('click', event => {
  const button = event.target.closest('.record');
  if(!button) return;
  selectedId = button.dataset.id;
  render();
});
$('search').addEventListener('input', render);
$('refresh').addEventListener('click', loadRecords);
$('clear').addEventListener('click', async () => {
  if(!confirm('确定清空所有答题记录？')) return;
  await fetch('/api/records', { method:'DELETE' });
  selectedId = null;
  await loadRecords();
});
loadRecords();
setInterval(loadRecords, 5000);
</script>
</body>
</html>`;
}

async function handleMonitor(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${monitorPort}`}`);

  if (req.method === 'GET' && url.pathname === '/') {
    send(res, 200, monitorHtml(), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/records') {
    const records = await readRecords();
    sendJson(res, 200, { records });
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/records') {
    await writeFile(recordsFile, '', 'utf8');
    sendJson(res, 200, { ok: true });
    return;
  }

  send(res, 404, 'Not Found');
}

createServer((req, res) => {
  handleApp(req, res).catch(error => {
    console.error(error);
    sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
  });
}).listen(appPort, host, () => {
  console.log(`ASTI app: http://${host}:${appPort}/`);
});

createServer((req, res) => {
  handleMonitor(req, res).catch(error => {
    console.error(error);
    sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
  });
}).listen(monitorPort, host, () => {
  console.log(`Monitor:  http://${host}:${monitorPort}/`);
});
