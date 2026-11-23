(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));

  const fmtTime = iso => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('zh-CN', { hour12: false });
  };

  const fmtDuration = ms => {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '-';
    const sec = Math.max(0, Math.round(Number(ms) / 1000));
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${min} 分 ${rem} 秒`;
  };

  let password = sessionStorage.getItem('watching_monitor_password') || '';
  let authRequired = false;
  let quizzes = [];
  let records = [];
  let activeQuizId = '';
  let activeStatus = '';
  let selectedId = null;
  let storageInfo = null;
  let pollTimer = null;
  let toastTimer = null;

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (password) {
      headers.Authorization = `Bearer ${password}`;
    }
    return fetch(url, { ...options, headers, cache: 'no-store' });
  }

  function showLogin(errorMessage = '') {
    stopPolling();
    $('app-view').classList.add('hidden');
    $('login-view').classList.remove('hidden');
    $('login-error').textContent = errorMessage;
    $('password-input').focus();
  }

  function showApp() {
    $('login-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    $('btn-logout').classList.toggle('hidden', !authRequired);
    startPolling();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!document.hidden) loadAll({ silent: true });
    }, 6000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function checkAuthAndBoot() {
    try {
      const res = await apiFetch('/api/auth/status');
      const data = await res.json();
      authRequired = Boolean(data.authRequired);
      if (authRequired && !data.authenticated) {
        showLogin('');
        return;
      }
      await loadAll();
      showApp();
    } catch {
      showLogin('无法连接到服务器，请确认后端服务已启动。');
    }
  }

  async function loadAll(options = {}) {
    const [quizRes, recRes] = await Promise.all([
      apiFetch('/api/quizzes?refresh=1'),
      apiFetch('/api/records')
    ]);

    if (recRes.status === 401 || quizRes.status === 401) {
      password = '';
      sessionStorage.removeItem('watching_monitor_password');
      showLogin(options.fromLogin ? '密码错误，请重新输入。' : '登录已失效，请重新输入密码。');
      return false;
    }

    const [quizData, recData] = await Promise.all([quizRes.json(), recRes.json()]);
    quizzes = Array.isArray(quizData.quizzes) ? quizData.quizzes : [];
    records = Array.isArray(recData.records) ? recData.records : [];
    storageInfo = recData.storage || null;

    if (storageInfo) {
      $('storage-badge').textContent = `存储：${storageInfo.type === 'redis' ? 'Upstash Redis' : '本地 JSONL'} (${storageInfo.location})`;
    }

    render();
    return true;
  }

  function getFilteredRecords() {
    const q = $('search-input').value.trim().toLowerCase();
    return records.filter(item => {
      if (activeQuizId && item.quizId !== activeQuizId) return false;
      if (activeStatus && item.status !== activeStatus) return false;
      if (q && !JSON.stringify(item).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderQuizStrip() {
    const countMap = new Map();
    for (const r of records) {
      countMap.set(r.quizId, (countMap.get(r.quizId) || 0) + 1);
    }

    const knownSlugs = new Set(quizzes.map(q => q.slug));
    const orphanQuizzes = Array.from(countMap.keys())
      .filter(slug => !knownSlugs.has(slug))
      .map(slug => ({
        slug,
        title: `${slug} (历史/已移除)`,
        mountPath: `/q/${encodeURIComponent(slug)}/`,
        hidden: false,
        orphan: true
      }));

    const allQuizzes = [...quizzes, ...orphanQuizzes];
    $('quiz-count-meta').textContent = `共发现 ${quizzes.length} 个测试`;

    const allCard = `
      <div class="quiz-chip ${activeQuizId === '' ? 'active' : ''}" data-quiz-filter="">
        <div class="quiz-chip-top">
          <span class="quiz-chip-title">全部测试</span>
          <span class="quiz-chip-count">${records.length}</span>
        </div>
        <div class="quiz-chip-actions">
          <span>聚合所有目录与历史记录</span>
        </div>
      </div>
    `;

    const cards = allQuizzes.map(quiz => {
      const count = countMap.get(quiz.slug) || 0;
      const fullUrl = `${window.location.origin}${quiz.mountPath}`;
      return `
        <div class="quiz-chip ${activeQuizId === quiz.slug ? 'active' : ''}" data-quiz-filter="${esc(quiz.slug)}">
          <div class="quiz-chip-top">
            <span class="quiz-chip-title" title="${esc(quiz.title)}">${esc(quiz.title || quiz.slug)}</span>
            <span class="quiz-chip-count">${count}</span>
          </div>
          <div class="quiz-chip-actions">
            <span class="mono">/${esc(quiz.slug)}${quiz.hidden ? ' · 隐藏' : ''}</span>
            ${quiz.orphan ? '' : `
              <span class="quiz-chip-links">
                <a class="inline-link" href="${esc(quiz.mountPath)}" target="_blank" rel="noopener" data-stop="1">打开</a>
                <button type="button" class="inline-link" data-copy-url="${esc(fullUrl)}" data-stop="1">复制链接</button>
              </span>
            `}
          </div>
        </div>
      `;
    }).join('');

    $('quiz-strip').innerHTML = allCard + cards;
  }

  function renderStats(filtered) {
    const scope = activeQuizId ? records.filter(r => r.quizId === activeQuizId) : records;
    $('stat-total').textContent = String(filtered.length);
    $('stat-completed').textContent = String(scope.filter(r => r.status === 'completed').length);
    $('stat-progress').textContent = String(scope.filter(r => r.status !== 'completed').length);
    $('stat-updated').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function getRecordHeadline(record) {
    const s = record.summary || {};
    const parts = [s.headline, s.title].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    if (s.score) return `得分 ${s.score}`;
    return record.status === 'completed' ? '已完成作答' : `作答中（已答 ${record.answeredCount || 0} 题）`;
  }

  function renderRecordList(list) {
    if (!list.length) {
      $('record-list').innerHTML = '<div class="empty-state" style="min-height:220px">暂无匹配记录</div>';
      return;
    }

    $('record-list').innerHTML = list.map(record => {
      const progressText = record.totalQuestions
        ? `${record.answeredCount || 0}/${record.totalQuestions} 题`
        : `${record.answeredCount || 0} 题`;
      const statusLabel = record.status === 'completed' ? '已完成' : '作答中';
      return `
        <button type="button" class="record-item ${record.id === selectedId ? 'active' : ''}" data-record-id="${esc(record.id)}">
          <div class="record-item-head">
            <span class="record-quiz-tag" title="${esc(record.quizTitle)}">${esc(record.quizTitle || record.quizId)}</span>
            <span class="status-pill ${esc(record.status)}">${statusLabel}</span>
          </div>
          <div class="record-headline">${esc(getRecordHeadline(record))}</div>
          <div class="record-meta">
            <span>${esc(fmtTime(record.updatedAt || record.createdAt))}</span>
            <span>· ${esc(progressText)}</span>
            ${record.ip ? `<span>· ${esc(record.ip)}</span>` : ''}
          </div>
        </button>
      `;
    }).join('');
  }

  function renderDetail(filtered) {
    const record = filtered.find(item => item.id === selectedId) || records.find(item => item.id === selectedId);
    if (!record) {
      $('record-detail').innerHTML = '<div class="empty-state">暂无记录，完成一次测试后将自动出现在这里。</div>';
      return;
    }

    const summary = record.summary || {};
    const metrics = Array.isArray(summary.metrics) ? summary.metrics : [];
    const badges = Array.isArray(summary.badges) ? summary.badges : [];
    const answers = Array.isArray(record.answers) ? record.answers : [];
    const statusLabel = record.status === 'completed' ? '已完成' : '作答中';
    const progressText = record.totalQuestions
      ? `${record.answeredCount || answers.length} / ${record.totalQuestions} 题`
      : `${record.answeredCount || answers.length} 题`;

    const metricsHtml = metrics.length
      ? `
        <h3 class="section-title">维度 / 指标解析 (${metrics.length})</h3>
        <div class="metrics-grid">
          ${metrics.map(m => {
            const pct = m.value !== null && m.max ? Math.max(0, Math.min(100, (m.value / m.max) * 100)) : null;
            return `
              <div class="metric-card">
                <div class="metric-head">
                  <span class="metric-label">${esc(m.label)}</span>
                  <span class="metric-val">${esc(m.display || m.value || '-')}</span>
                </div>
                ${pct !== null ? `<div class="metric-bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `
      : '';

    const badgesHtml = badges.length
      ? `<div class="badge-row">${badges.map(b => `<span class="tag-badge">${esc(b)}</span>`).join('')}</div>`
      : '';

    const summaryTextHtml = summary.text
      ? `
        <h3 class="section-title">结果页摘要文本</h3>
        <div class="summary-box">${esc(summary.text)}</div>
      `
      : '';

    const answersRows = answers.map((ans, idx) => {
      const rawValNote = Array.isArray(ans.values) && ans.values.length
        ? ans.values.join(', ')
        : '';
      const showRawVal = rawValNote && rawValNote !== ans.answer;
      const optionsHtml = Array.isArray(ans.allOptions) && ans.allOptions.length
        ? `
          <details class="options-disclosure">
            <summary>全部候选选项 (${ans.allOptions.length})</summary>
            <div>${esc(ans.allOptions.join(' / '))}</div>
          </details>
        `
        : '';

      return `
        <tr>
          <td class="col-idx">${esc(ans.order ?? idx + 1)}</td>
          <td>
            <div>${esc(ans.question || '-')}</div>
            ${optionsHtml}
          </td>
          <td class="col-ans">
            <span class="ans-pill">${esc(ans.answer || '-')}</span>
            <span class="ans-sub">
              ${showRawVal ? `原值: ${esc(rawValNote)} · ` : ''}${esc(ans.inputType || 'auto')}${ans.changeCount > 1 ? ` · 修改 ${ans.changeCount - 1} 次` : ''}
            </span>
          </td>
        </tr>
      `;
    }).join('');

    $('record-detail').innerHTML = `
      <div class="detail-header">
        <div>
          <div class="detail-tags">
            <span class="record-quiz-tag">${esc(record.quizTitle || record.quizId)}</span>
            <span class="status-pill ${esc(record.status)}">${statusLabel}</span>
            <span class="tag-badge">采集模式：${esc(record.collectorMode || 'auto')}</span>
            ${summary.score ? `<span class="tag-badge">分数：${esc(summary.score)}</span>` : ''}
          </div>
          <h2 class="detail-title">${esc(getRecordHeadline(record))}</h2>
          ${summary.subtitle ? `<p class="detail-subtitle">${esc(summary.subtitle)}</p>` : ''}
        </div>
        <div class="detail-actions">
          <button type="button" class="btn btn-sm" id="btn-copy-record">复制 JSON</button>
          <button type="button" class="btn btn-sm btn-danger" id="btn-delete-record" data-id="${esc(record.id)}">删除此条</button>
        </div>
      </div>

      <div class="meta-bar">
        <span><strong>答题进度：</strong>${esc(progressText)}</span>
        <span><strong>用时：</strong>${esc(fmtDuration(record.durationMs))}</span>
        <span><strong>更新时间：</strong>${esc(fmtTime(record.updatedAt || record.createdAt))}</span>
        <span><strong>IP：</strong>${esc(record.ip || '-')}</span>
        <span><strong>路径：</strong><code>${esc(record.pagePath || '-')}</code></span>
      </div>

      ${badgesHtml}
      ${metricsHtml}
      ${summaryTextHtml}

      <h3 class="section-title">答题选项明细 (${answers.length})</h3>
      ${answers.length ? `
        <div class="answers-table-wrap">
          <table class="answers-table">
            <thead>
              <tr>
                <th>#</th>
                <th>题目</th>
                <th>所选回答</th>
              </tr>
            </thead>
            <tbody>${answersRows}</tbody>
          </table>
        </div>
      ` : '<div class="empty-state" style="min-height:120px">暂无答题明细</div>'}
    `;

    const copyBtn = $('btn-copy-record');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(JSON.stringify(record, null, 2))
          .then(() => showToast('已复制该记录 JSON'))
          .catch(() => showToast('复制失败'));
      });
    }

    const delBtn = $('btn-delete-record');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('确定删除这条答题记录？')) return;
        const res = await apiFetch(`/api/records?id=${encodeURIComponent(record.id)}`, { method: 'DELETE' });
        if (res.ok) {
          selectedId = null;
          showToast('已删除记录');
          await loadAll();
        }
      });
    }
  }

  function render() {
    const filtered = getFilteredRecords();
    if (!filtered.some(item => item.id === selectedId)) {
      selectedId = filtered[0] ? filtered[0].id : null;
    }
    renderQuizStrip();
    renderStats(filtered);
    renderRecordList(filtered);
    renderDetail(filtered);
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportCsv(list) {
    const csvEsc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['recordId', 'quizId', 'quizTitle', 'status', 'updatedAt', 'ip', 'resultHeadline', 'resultTitle', 'score', 'questionOrder', 'question', 'answer', 'rawValues', 'inputType']
    ];
    for (const r of list) {
      const answers = Array.isArray(r.answers) && r.answers.length ? r.answers : [null];
      for (const ans of answers) {
        rows.push([
          r.id,
          r.quizId,
          r.quizTitle,
          r.status,
          r.updatedAt || r.createdAt,
          r.ip || '',
          r.summary?.headline || '',
          r.summary?.title || '',
          r.summary?.score || '',
          ans ? ans.order : '',
          ans ? ans.question : '',
          ans ? ans.answer : '',
          ans ? (ans.values || []).join('|') : '',
          ans ? ans.inputType : ''
        ]);
      }
    }
    const csv = '\uFEFF' + rows.map(row => row.map(csvEsc).join(',')).join('\n');
    downloadFile(`quiz-records-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
  }

  // ---- Event Bindings ----

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    password = $('password-input').value;
    sessionStorage.setItem('watching_monitor_password', password);
    const ok = await loadAll({ fromLogin: true });
    if (ok) showApp();
  });

  $('quiz-strip').addEventListener('click', event => {
    const copyBtn = event.target.closest('[data-copy-url]');
    if (copyBtn) {
      event.stopPropagation();
      const url = copyBtn.getAttribute('data-copy-url');
      navigator.clipboard?.writeText(url)
        .then(() => showToast(`已复制链接：${url}`))
        .catch(() => showToast('复制失败'));
      return;
    }
    if (event.target.closest('[data-stop="1"]')) return;

    const chip = event.target.closest('.quiz-chip');
    if (!chip) return;
    activeQuizId = chip.getAttribute('data-quiz-filter') || '';
    selectedId = null;
    render();
  });

  $('record-list').addEventListener('click', event => {
    const btn = event.target.closest('.record-item');
    if (!btn) return;
    selectedId = btn.getAttribute('data-record-id');
    render();
  });

  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeStatus = btn.getAttribute('data-status') || '';
      selectedId = null;
      render();
    });
  });

  $('search-input').addEventListener('input', render);

  $('btn-refresh').addEventListener('click', async () => {
    await loadAll();
    showToast('已刷新');
  });

  $('btn-export-json').addEventListener('click', () => {
    const list = getFilteredRecords();
    downloadFile(
      `quiz-records-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(list, null, 2),
      'application/json;charset=utf-8'
    );
  });

  $('btn-export-csv').addEventListener('click', () => {
    exportCsv(getFilteredRecords());
  });

  $('btn-logout').addEventListener('click', () => {
    password = '';
    sessionStorage.removeItem('watching_monitor_password');
    $('password-input').value = '';
    showLogin('');
  });

  $('btn-clear').addEventListener('click', async () => {
    const label = activeQuizId ? `测试 "${activeQuizId}" 的所有记录` : '全部测试的所有记录';
    if (!confirm(`确定清空${label}？此操作不可撤销。`)) return;
    const query = activeQuizId ? `?quizId=${encodeURIComponent(activeQuizId)}` : '';
    const res = await apiFetch(`/api/records${query}`, { method: 'DELETE' });
    if (res.ok) {
      selectedId = null;
      showToast('已清空记录');
      await loadAll();
    }
  });

  checkAuthAndBoot();
})();
