(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__WATCHING_COLLECTOR_LOADED__) return;
  window.__WATCHING_COLLECTOR_LOADED__ = true;

  // Skip local file:// usage so offline saved copies stay silent.
  if (window.location && window.location.protocol === 'file:') return;

  const scriptEl =
    document.currentScript ||
    document.querySelector('script[data-watching-collector]');

  const QUIZ_ID = (scriptEl && scriptEl.getAttribute('data-quiz-id')) || deriveSlugFromPath();
  const QUIZ_TITLE = (scriptEl && scriptEl.getAttribute('data-quiz-title')) || '';
  const API_ENDPOINT = (scriptEl && scriptEl.getAttribute('data-api-endpoint')) || '/api/records';

  let CUSTOM_CONFIG = {};
  try {
    const rawCfg = scriptEl && scriptEl.getAttribute('data-quiz-config');
    if (rawCfg) {
      const parsed = JSON.parse(rawCfg);
      if (parsed && typeof parsed === 'object') CUSTOM_CONFIG = parsed;
    }
  } catch {
    CUSTOM_CONFIG = {};
  }

  const STORAGE_KEY = `__watching_session_v2__:${QUIZ_ID}`;

  const RE_RESTART = /^(重新测试|再测一次|重新开始|重做|再来一次|再试一次|重新答题|restart|retake|try again|start over|redo)$/i;
  const RE_SUBMIT = /(查看结果|提交问卷|提交答案|提交测试|提交|生成报告|查看报告|计算结果|完成测试|完成答题|交卷|揭晓结果|获取结果|看结果|submit|finish|get result|see result|show result|view result|calculate|complete)/i;
  const RE_NAV_OR_UTIL = /^(开始测试|开始答题|立即开始|开始|进入测试|下一题|下一步|继续|上一题|上一步|返回|跳过|复制结果|复制|分享结果|分享|保存图片|保存|下载|关闭|取消|确认|确定|知道了|start|begin|start quiz|start test|next|next question|continue|prev|previous|back|skip|copy|copy result|share|save|download|close|cancel|ok)$/i;
  const RE_PROGRESS_ONLY = /^(?:第\s*\d+\s*题(?:\s*[/／]\s*共?\s*\d+\s*题?)?|Q?\d+\s*[/／]\s*\d+|进度[:：\s]*\d+\s*[/／]\s*\d+|\d+\s*%)$/i;
  const RE_OPT_HINT = /(opt|option|choice|answer|ans|scale|likert|radio|check|item|pill|card|btn)/i;
  const RE_QUESTION_HINT = /(q[-_]?text|question[-_]?text|question[-_]?title|q[-_]?title|question|prompt|stem|subject|topic|ask|query|title)/i;
  const RE_RESULT_HINT = /(result|report|outcome|score[-_]?card|final[-_]?score|summary|finish|verdict|diagnosis|personality)/i;
  const RE_SELECTED_CLASS = /(^|\s|[-_])(selected|active|checked|chosen|current|is-selected|is-active|on)(\s|[-_]|$)/i;

  function deriveSlugFromPath() {
    try {
      const match = (window.location.pathname || '').match(/^\/q\/([^/]+)/);
      if (match) return decodeURIComponent(match[1]);
    } catch {
      // ignore
    }
    return 'default';
  }

  function createUuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function cleanText(text, maxLen = 600) {
    return String(text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen);
  }

  function cleanMultilineText(text, maxLen = 6000) {
    return String(text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, maxLen);
  }

  function normalizeKeyPart(text) {
    return cleanText(text, 120)
      .toLowerCase()
      .replace(/^[q第]?\s*\d+\s*[题.、:：\)\]]\s*/i, '')
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    // Walk up ancestors to catch hidden wrapper screens (e.g. #scr-result { display: none }).
    let parent = el.parentElement;
    while (parent && parent !== document.documentElement) {
      if (parent.hidden || parent.getAttribute('aria-hidden') === 'true') return false;
      const pStyle = window.getComputedStyle(parent);
      if (pStyle && (pStyle.display === 'none' || pStyle.visibility === 'hidden')) return false;
      parent = parent.parentElement;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.offsetParent !== null;
  }

  function matchesOptionalSelector(el, selector) {
    if (!el || !selector || typeof el.matches !== 'function') return false;
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }

  function closestOptional(el, selector) {
    if (!el || !selector || typeof el.closest !== 'function') return null;
    try {
      return el.closest(selector);
    } catch {
      return null;
    }
  }

  function isIgnoredElement(el) {
    if (!el || el.nodeType !== 1) return true;
    if (CUSTOM_CONFIG.ignoreSelector && closestOptional(el, CUSTOM_CONFIG.ignoreSelector)) {
      return true;
    }
    return Boolean(el.closest('script, style, noscript, template'));
  }

  function createFreshState() {
    return {
      sessionId: createUuid(),
      startedAt: new Date().toISOString(),
      status: 'in_progress',
      completedAt: null,
      totalQuestions: null,
      answers: {},
      answerSequence: 0,
      summary: null,
      rawResult: null,
      collectorMode: 'auto'
    };
  }

  function loadSessionState() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return createFreshState();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.sessionId) {
        return createFreshState();
      }
      return {
        ...createFreshState(),
        ...parsed,
        answers: parsed.answers && typeof parsed.answers === 'object' ? parsed.answers : {}
      };
    } catch {
      return createFreshState();
    }
  }

  function saveSessionState() {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore storage quota or private mode failures.
    }
  }

  let state = loadSessionState();
  let lastSentHash = '';
  let syncTimer = null;
  let resultWatchTimer = null;
  let settleTimer = null;
  let submitSignaledAt = 0;
  let lastActiveQuestionContainer = null;
  const groupUidMap = new WeakMap();
  let nextGroupUid = 1;

  function getGroupUid(el) {
    if (!el) return 0;
    let uid = groupUidMap.get(el);
    if (!uid) {
      uid = nextGroupUid++;
      groupUidMap.set(el, uid);
    }
    return uid;
  }

  function getQuizTitle() {
    return cleanText(QUIZ_TITLE || document.title || QUIZ_ID, 160);
  }

  function getOrderedAnswers() {
    return Object.values(state.answers).sort((a, b) => {
      const orderDiff = (a.order || 0) - (b.order || 0);
      if (orderDiff !== 0) return orderDiff;
      return (a._seq || 0) - (b._seq || 0);
    });
  }

  function buildPayload() {
    const answers = getOrderedAnswers().map(item => ({
      key: item.key,
      order: item.order,
      question: item.question,
      answer: item.answer,
      values: item.values,
      selectedOptions: item.selectedOptions,
      allOptions: item.allOptions,
      inputType: item.inputType,
      changeCount: item.changeCount,
      answeredAt: item.answeredAt
    }));

    return {
      schemaVersion: 2,
      sessionId: state.sessionId,
      quizId: QUIZ_ID,
      quizTitle: getQuizTitle(),
      pagePath: window.location ? window.location.pathname : '',
      status: state.status,
      collectorMode: state.collectorMode || 'auto',
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      totalQuestions: state.totalQuestions,
      answeredCount: answers.length,
      summary: state.summary || {},
      answers,
      rawResult: state.rawResult || null
    };
  }

  function computeQuickHash(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${str.length}:${hash >>> 0}`;
  }

  let inFlight = false;
  let queuedForce = false;

  function serializePayloadForBeacon(payload) {
    let body = JSON.stringify(payload);
    // Chrome limits sendBeacon / keepalive payloads to 64 KiB; drop optional candidate lists if close to limit.
    if (body.length > 56000) {
      const compact = {
        ...payload,
        answers: (payload.answers || []).map(({ allOptions, ...rest }) => rest)
      };
      body = JSON.stringify(compact);
    }
    return body;
  }

  function sendPayload(options = {}) {
    const answersCount = Object.keys(state.answers).length;
    const hasSummary = Boolean(
      state.summary &&
      (state.summary.headline || state.summary.title || state.summary.score || state.summary.text)
    );
    if (answersCount === 0 && !hasSummary) return;

    const payload = buildPayload();

    if (options.beacon) {
      const beaconBody = serializePayloadForBeacon(payload);
      const beaconHash = computeQuickHash(beaconBody);
      if (!options.force && beaconHash === lastSentHash) return;
      lastSentHash = beaconHash;

      if (navigator.sendBeacon) {
        try {
          const sent = navigator.sendBeacon(
            API_ENDPOINT,
            new Blob([beaconBody], { type: 'application/json' })
          );
          if (sent) return;
        } catch {
          // Fall back to keepalive fetch below.
        }
      }

      try {
        fetch(API_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: beaconBody,
          keepalive: true
        }).catch(() => {});
      } catch {
        // Never throw inside host page.
      }
      return;
    }

    if (inFlight) {
      queuedForce = queuedForce || Boolean(options.force);
      return;
    }

    const body = JSON.stringify(payload);
    const hash = computeQuickHash(body);
    if (!options.force && hash === lastSentHash) return;
    lastSentHash = hash;
    inFlight = true;

    try {
      fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      })
        .catch(() => {
          // Allow retry on next sync if network failed.
          lastSentHash = '';
        })
        .finally(() => {
          inFlight = false;
          if (queuedForce || computeQuickHash(JSON.stringify(buildPayload())) !== lastSentHash) {
            const nextForce = queuedForce;
            queuedForce = false;
            sendPayload({ force: nextForce });
          }
        });
    } catch {
      inFlight = false;
    }
  }

  function scheduleSync(delayMs = 1800) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      sendPayload();
    }, delayMs);
  }

  function recordAnswer(entry) {
    if (!entry || !entry.key) return;
    const now = new Date().toISOString();
    const existing = state.answers[entry.key];

    // If user previously completed the quiz and starts answering Q1 again without hitting a recognized restart button, rotate session.
    if (state.status === 'completed' && entry.order === 1 && !existing) {
      resetSession(false);
    }

    const order = entry.order || (existing && existing.order) || ++state.answerSequence;
    if (order > state.answerSequence) state.answerSequence = order;

    if (entry.totalQuestions && (!state.totalQuestions || entry.totalQuestions > state.totalQuestions)) {
      state.totalQuestions = entry.totalQuestions;
    }

    const selectedOptions = (entry.selectedOptions || [])
      .map(v => cleanText(v, 300))
      .filter(Boolean);
    const values = (entry.values || [])
      .map(v => cleanText(v, 200))
      .filter(Boolean);
    const answerText = cleanText(
      entry.answer || selectedOptions.join('、') || values.join('、'),
      600
    );

    if (!answerText && selectedOptions.length === 0 && values.length === 0) {
      return;
    }

    const changed = existing ? existing.answer !== answerText : false;
    state.answers[entry.key] = {
      key: entry.key,
      order,
      _seq: existing ? existing._seq : ++state.answerSequence,
      question: cleanText(entry.question || (existing && existing.question) || `第 ${order} 题`, 600),
      answer: answerText,
      values,
      selectedOptions: selectedOptions.length ? selectedOptions : [answerText],
      allOptions: (entry.allOptions || (existing && existing.allOptions) || [])
        .map(v => cleanText(v, 200))
        .filter(Boolean)
        .slice(0, 30),
      inputType: entry.inputType || (existing && existing.inputType) || 'custom',
      changeCount: existing ? existing.changeCount + (changed ? 1 : 0) : 1,
      answeredAt: now
    };

    saveSessionState();
    scheduleSync(1500);
  }

  function resetSession(flushFirst = true) {
    if (flushFirst) {
      sendPayload({ force: false });
    }
    state = createFreshState();
    lastSentHash = '';
    submitSignaledAt = 0;
    saveSessionState();
  }

  // ---- Progress / Question Number Extraction ----

  function parseProgressFromText(text) {
    const cleaned = cleanText(text, 200);
    if (!cleaned) return { order: null, total: null };

    // "第 12 题 / 共 85 题" or "第12题"
    let m = cleaned.match(/第\s*(\d+)\s*题(?:\s*[/／|·\s]*共?\s*(\d+)\s*题?)?/);
    if (m) {
      return {
        order: Number(m[1]) || null,
        total: m[2] ? Number(m[2]) || null : null
      };
    }

    // "12 / 85" or "Q12/85"
    m = cleaned.match(/(?:^|\s|Q|进度[:：\s]*)(\d{1,3})\s*[/／]\s*(\d{1,3})(?:\s|$)/i);
    if (m) {
      const order = Number(m[1]);
      const total = Number(m[2]);
      if (order >= 1 && total >= order && total <= 500) {
        return { order, total };
      }
    }

    // Leading numbered question: "12. ..." or "Q12: ..." or "12、"
    m = cleaned.match(/^(?:Q|q|问题|题目)?\s*(\d{1,3})\s*[.、:：\)\]]\s*\S/);
    if (m) {
      const order = Number(m[1]);
      if (order >= 1 && order <= 500) {
        return { order, total: null };
      }
    }

    return { order: null, total: null };
  }

  function extractProgressNear(container) {
    const scopes = [];
    if (container) scopes.push(container);
    if (container && container.parentElement) scopes.push(container.parentElement);
    scopes.push(document.body);

    let bestOrder = null;
    let bestTotal = null;

    const selectors = [
      '[id*="q-num"]', '[class*="q-num"]',
      '[id*="prog"]', '[class*="prog"]',
      '[class*="step"]', '[class*="counter"]',
      '[class*="index"]', '[class*="number"]'
    ].join(',');

    for (const scope of scopes) {
      if (!scope || !scope.querySelectorAll) continue;
      const nodes = scope.querySelectorAll(selectors);
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = cleanText(node.innerText || node.textContent, 120);
        if (!text || text.length > 60) continue;
        const parsed = parseProgressFromText(text);
        if (parsed.order && !bestOrder) bestOrder = parsed.order;
        if (parsed.total && !bestTotal) bestTotal = parsed.total;
        if (bestOrder && bestTotal) return { order: bestOrder, total: bestTotal };
      }
      if (bestOrder && bestTotal) break;
    }

    return { order: bestOrder, total: bestTotal };
  }

  // ---- Question Text Resolution ----

  function isLikelyHeaderOrChrome(el) {
    if (!el) return true;
    if (el.closest('header, nav, footer, .header, .navbar, .nav, .btn-row, .actions, .disclaimer')) {
      return true;
    }
    return false;
  }

  function isValidQuestionCandidateText(text, optionTextsSet) {
    const t = cleanText(text, 600);
    if (!t || t.length < 2 || t.length > 500) return false;
    if (RE_PROGRESS_ONLY.test(t)) return false;
    if (RE_NAV_OR_UTIL.test(t) || RE_RESTART.test(t)) return false;
    if (optionTextsSet && optionTextsSet.has(t)) return false;
    return true;
  }

  function findQuestionContext(groupEl, optionTexts = []) {
    const optionTextsSet = new Set(optionTexts.map(t => cleanText(t, 200)));

    // 1. Custom selector from quiz.config.json takes top priority.
    if (CUSTOM_CONFIG.questionSelector) {
      let scope = groupEl ? groupEl.parentElement : document.body;
      for (let depth = 0; depth < 4 && scope && scope !== document.documentElement; depth++) {
        const match = scope.querySelector(CUSTOM_CONFIG.questionSelector);
        if (match && isVisible(match) && !match.contains(groupEl)) {
          const text = cleanText(match.innerText || match.textContent, 600);
          if (text) {
            const prog = extractProgressNear(scope);
            const fromText = parseProgressFromText(text);
            return {
              container: scope,
              question: text,
              order: prog.order || fromText.order,
              totalQuestions: prog.total || fromText.total
            };
          }
        }
        scope = scope.parentElement;
      }
    }

    // 2. Determine the tightest question card/container around groupEl.
    let container = groupEl ? groupEl.parentElement : null;
    let bestQuestion = '';
    let bestContainer = container;

    for (let depth = 0; depth < 4 && container && container !== document.body && container !== document.documentElement; depth++) {
      // Stop climbing if this container clearly wraps multiple unrelated question cards/fieldsets.
      if (depth > 0) {
        const multiFieldsets = container.querySelectorAll('fieldset').length;
        const multiGroups = container.querySelectorAll('[role="radiogroup"], .options, .q-opts, .choices').length;
        if (multiFieldsets > 1 || multiGroups > 1) {
          break;
        }
      }

      // 2a. Explicit semantic question elements inside container (excluding groupEl and chrome).
      const semanticNodes = container.querySelectorAll(
        'legend, [id*="q-text"], [class*="q-text"], [class*="question-text"], [class*="question-title"], [class*="q-title"], [class*="stem"], [class*="prompt"], [class*="subject"], h2, h3, h4, h5, [class*="question"], [id*="question"]'
      );
      for (const node of semanticNodes) {
        if (node === groupEl || groupEl.contains(node) || node.contains(groupEl)) continue;
        if (!isVisible(node) || isLikelyHeaderOrChrome(node)) continue;
        // Skip wrapper divs that contain nested option buttons or inputs.
        if (node.querySelector('input, select, textarea, button')) continue;
        const text = cleanText(node.innerText || node.textContent, 600);
        if (isValidQuestionCandidateText(text, optionTextsSet)) {
          bestQuestion = text;
          bestContainer = container;
          break;
        }
      }
      if (bestQuestion) break;

      // 2b. Walk preceding siblings of groupEl (or of the ancestor branch inside container).
      let branch = groupEl;
      while (branch && branch.parentElement !== container) {
        branch = branch.parentElement;
      }
      let prev = branch ? branch.previousElementSibling : null;
      while (prev) {
        if (isVisible(prev) && !isLikelyHeaderOrChrome(prev) && !prev.querySelector('input, select, textarea')) {
          const text = cleanText(prev.innerText || prev.textContent, 600);
          if (isValidQuestionCandidateText(text, optionTextsSet)) {
            bestQuestion = text;
            bestContainer = container;
            break;
          }
        }
        prev = prev.previousElementSibling;
      }
      if (bestQuestion) break;

      container = container.parentElement;
    }

    // 2c. Fallback for table rows (<tr><td>Question</td><td>options...</td></tr>)
    if (!bestQuestion && groupEl) {
      const tr = groupEl.closest('tr');
      if (tr) {
        for (const cell of tr.cells) {
          if (cell === groupEl || cell.contains(groupEl)) continue;
          const text = cleanText(cell.innerText || cell.textContent, 600);
          if (isValidQuestionCandidateText(text, optionTextsSet)) {
            bestQuestion = text;
            bestContainer = tr;
            break;
          }
        }
      }
    }

    const fromText = parseProgressFromText(bestQuestion);
    const nearProg = extractProgressNear(bestContainer || groupEl);
    // Avoid attaching global page progress to individual items in a multi-question long form.
    const isSingleQuestionView =
      document.querySelectorAll('fieldset, [role="radiogroup"], .options, .q-opts').length <= 1;

    return {
      container: bestContainer || groupEl,
      question: bestQuestion,
      order: fromText.order || (isSingleQuestionView ? nearProg.order : null),
      totalQuestions: fromText.total || nearProg.total
    };
  }

  // ---- Native Form Input Capture ----

  function getLabelForInput(input) {
    if (!input) return '';

    if (input.labels && input.labels.length > 0) {
      for (const lbl of input.labels) {
        const clone = lbl.cloneNode(true);
        clone.querySelectorAll('input, select, textarea').forEach(n => n.remove());
        const text = cleanText(clone.textContent, 300);
        if (text) return text;
      }
    }

    if (input.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape ? CSS.escape(input.id) : input.id.replace(/"/g, '\\"')}"]`);
      if (lbl) {
        const text = cleanText(lbl.innerText || lbl.textContent, 300);
        if (text) return text;
      }
    }

    const parentLabel = input.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach(n => n.remove());
      const text = cleanText(clone.textContent, 300);
      if (text) return text;
    }

    const ariaLabel = input.getAttribute('aria-label');
    if (ariaLabel) return cleanText(ariaLabel, 300);

    // Adjacent text node / span sibling (e.g., <input type="radio"><span>Yes</span>)
    let sibling = input.nextSibling;
    while (sibling) {
      if (sibling.nodeType === 3 && cleanText(sibling.textContent, 200)) {
        return cleanText(sibling.textContent, 200);
      }
      if (sibling.nodeType === 1) {
        if (sibling.matches('input, select, textarea, br')) break;
        const text = cleanText(sibling.innerText || sibling.textContent, 200);
        if (text) return text;
        break;
      }
      sibling = sibling.nextSibling;
    }

    return cleanText(input.value, 200);
  }

  function findCommonAncestor(elements) {
    if (!elements.length) return null;
    let ancestor = elements[0].parentElement;
    while (ancestor && ancestor !== document.body) {
      if (elements.every(el => ancestor.contains(el))) {
        return ancestor;
      }
      ancestor = ancestor.parentElement;
    }
    return elements[0].parentElement;
  }

  function getFormInputGroup(input) {
    const tag = input.tagName.toLowerCase();
    const type = (input.type || '').toLowerCase();

    if (tag === 'input' && (type === 'radio' || type === 'checkbox')) {
      const scope = input.form || document;
      if (input.name) {
        const escaped = CSS.escape ? CSS.escape(input.name) : input.name.replace(/"/g, '\\"');
        const sameName = Array.from(scope.querySelectorAll(`input[type="${type}"][name="${escaped}"]`));
        if (sameName.length > 0) {
          return {
            inputs: sameName,
            groupEl: findCommonAncestor(sameName) || input.parentElement
          };
        }
      }
      const container = input.closest('fieldset, [role="radiogroup"], [role="group"], .question, .q-item, .form-group, li, tr') || input.parentElement;
      const groupInputs = container ? Array.from(container.querySelectorAll(`input[type="${type}"]`)) : [input];
      return { inputs: groupInputs, groupEl: container || input.parentElement };
    }

    return {
      inputs: [input],
      groupEl: input.closest('label, .form-group, .field, .question, .q-item, fieldset, li, tr') || input.parentElement
    };
  }

  function captureNativeInput(input) {
    if (!input || isIgnoredElement(input)) return;
    const tag = input.tagName.toLowerCase();
    const type = tag === 'input' ? (input.type || 'text').toLowerCase() : tag;

    if (type === 'hidden' || type === 'password' || type === 'submit' || type === 'button' || type === 'reset' || type === 'file') {
      return;
    }

    const { inputs, groupEl } = getFormInputGroup(input);
    const allOptions = (type === 'radio' || type === 'checkbox')
      ? inputs.map(el => getLabelForInput(el)).filter(Boolean)
      : tag === 'select'
        ? Array.from(input.options).map(opt => cleanText(opt.text, 200)).filter(Boolean)
        : [];

    const ctx = findQuestionContext(groupEl, allOptions);
    lastActiveQuestionContainer = ctx.container || groupEl;

    let questionText = ctx.question;
    if (!questionText && (tag === 'select' || tag === 'textarea' || (tag === 'input' && type !== 'radio' && type !== 'checkbox'))) {
      questionText = getLabelForInput(input) || cleanText(input.placeholder || input.name || input.id, 200);
    }

    const namePart = input.name ? `name:${input.name}` : `el:${getGroupUid(groupEl)}`;
    const textPart = normalizeKeyPart(questionText);
    const key = textPart ? `form:${namePart}:${textPart}` : `form:${namePart}`;

    if (type === 'radio') {
      const checked = inputs.find(el => el.checked);
      if (!checked) return;
      const label = getLabelForInput(checked);
      const val = cleanText(checked.value, 200);
      recordAnswer({
        key,
        order: ctx.order,
        totalQuestions: ctx.totalQuestions,
        question: questionText || input.name || '单选题',
        answer: label || val,
        values: val ? [val] : [],
        selectedOptions: [label || val],
        allOptions,
        inputType: 'radio'
      });
      return;
    }

    if (type === 'checkbox') {
      const checkedList = inputs.filter(el => el.checked);
      if (checkedList.length === 0) {
        if (state.answers[key]) {
          delete state.answers[key];
          saveSessionState();
          scheduleSync(1500);
        }
        return;
      }
      const labels = checkedList.map(el => getLabelForInput(el) || cleanText(el.value, 200)).filter(Boolean);
      const vals = checkedList.map(el => cleanText(el.value, 200)).filter(Boolean);
      recordAnswer({
        key,
        order: ctx.order,
        totalQuestions: ctx.totalQuestions,
        question: questionText || input.name || '多选题',
        answer: labels.join('、'),
        values: vals,
        selectedOptions: labels,
        allOptions,
        inputType: 'checkbox'
      });
      return;
    }

    if (tag === 'select') {
      const selectedOpts = Array.from(input.selectedOptions || []);
      const labels = selectedOpts.map(opt => cleanText(opt.text, 200)).filter(Boolean);
      const vals = selectedOpts.map(opt => cleanText(opt.value, 200)).filter(Boolean);
      if (!vals.length || (vals.length === 1 && vals[0] === '' && /^(请选择|select|--)/i.test(labels[0] || ''))) {
        return;
      }
      recordAnswer({
        key,
        order: ctx.order,
        totalQuestions: ctx.totalQuestions,
        question: questionText || input.name || '下拉选择题',
        answer: labels.join('、'),
        values: vals,
        selectedOptions: labels,
        allOptions,
        inputType: 'select'
      });
      return;
    }

    if (type === 'range') {
      const val = cleanText(input.value, 60);
      const min = input.min !== '' ? input.min : '0';
      const max = input.max !== '' ? input.max : '100';
      const display = `${val} (${min}~${max})`;
      recordAnswer({
        key,
        order: ctx.order,
        totalQuestions: ctx.totalQuestions,
        question: questionText || input.name || '滑块题',
        answer: display,
        values: [val],
        selectedOptions: [display],
        allOptions: [],
        inputType: 'range'
      });
      return;
    }

    const val = cleanText(input.value, 600);
    if (!val) return;
    recordAnswer({
      key,
      order: ctx.order,
      totalQuestions: ctx.totalQuestions,
      question: questionText || input.name || '填空题',
      answer: val,
      values: [val],
      selectedOptions: [val],
      allOptions: [],
      inputType: tag === 'textarea' ? 'textarea' : 'text'
    });
  }

  function snapshotFormInputs(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const seenRadioNames = new Set();
    const seenCheckboxGroups = new Set();

    for (const el of scope.querySelectorAll('input, select, textarea')) {
      if (isIgnoredElement(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;

      if (type === 'radio') {
        if (!el.checked) continue;
        const radioKey = el.name || String(getGroupUid(el.parentElement));
        if (seenRadioNames.has(radioKey)) continue;
        seenRadioNames.add(radioKey);
        captureNativeInput(el);
      } else if (type === 'checkbox') {
        if (!el.checked) continue;
        const cbKey = el.name || String(getGroupUid(el.closest('fieldset, .question, .form-group') || el.parentElement));
        if (seenCheckboxGroups.has(cbKey)) continue;
        seenCheckboxGroups.add(cbKey);
        captureNativeInput(el);
      } else if (tag === 'select') {
        if (el.value !== '') captureNativeInput(el);
      } else if (type === 'range') {
        if (el.dataset.watchingTouched === '1' || root && root.tagName === 'FORM') {
          captureNativeInput(el);
        }
      } else if (el.value && cleanText(el.value, 200)) {
        captureNativeInput(el);
      }
    }
  }

  // ---- Custom Clickable Option Capture (SPA / Cards / Div Buttons / Likert) ----

  function hasInteractiveSignals(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a') return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'button' || role === 'radio' || role === 'option' || role === 'checkbox' || role === 'menuitem') {
      return true;
    }
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
    if (
      el.hasAttribute('data-val') ||
      el.hasAttribute('data-value') ||
      el.hasAttribute('data-score') ||
      el.hasAttribute('data-option') ||
      el.hasAttribute('data-choice') ||
      el.hasAttribute('data-answer') ||
      el.hasAttribute('data-index')
    ) {
      return true;
    }
    const clsId = `${el.className || ''} ${el.id || ''}`;
    if (RE_OPT_HINT.test(clsId)) return true;
    const style = window.getComputedStyle(el);
    return Boolean(style && style.cursor === 'pointer');
  }

  function findClickableCandidate(rawTarget) {
    if (!rawTarget || rawTarget.nodeType !== 1) return null;

    if (CUSTOM_CONFIG.optionSelector) {
      const explicit = closestOptional(rawTarget, CUSTOM_CONFIG.optionSelector);
      if (explicit && !isIgnoredElement(explicit)) return explicit;
    }

    let node = rawTarget;
    for (let depth = 0; depth < 6 && node && node !== document.body && node !== document.documentElement; depth++) {
      if (isIgnoredElement(node)) return null;
      const tag = node.tagName.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'option') {
        return null;
      }
      if (tag === 'label' && (node.control || node.querySelector('input, select, textarea'))) {
        return null;
      }
      if (node.querySelector && node.querySelector('input, select, textarea')) {
        // Don't treat a wrapper containing native form controls as a custom option button.
        return null;
      }
      if (hasInteractiveSignals(node)) {
        const textLen = cleanText(node.innerText || node.textContent, 400).length;
        // Guard against clicking a giant card/page container that happens to have cursor: pointer.
        if (textLen <= 260) {
          return node;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function findSiblingOptionGroup(candidate) {
    if (!candidate || !candidate.parentElement) return null;

    const parent = candidate.parentElement;
    const directChildren = Array.from(parent.children).filter(el => isVisible(el));

    // Case 1: Options are direct siblings (e.g. #q-opts > .opt-btn).
    const sameTagDirect = directChildren.filter(
      el => el.tagName === candidate.tagName && !el.querySelector('input, select, textarea')
    );
    if (sameTagDirect.length >= 2 && sameTagDirect.length <= 20) {
      return {
        groupEl: parent,
        options: sameTagDirect,
        index: sameTagDirect.indexOf(candidate)
      };
    }

    // Case 2: Options are wrapped one level deep (e.g. ul > li > button).
    const grandParent = parent.parentElement;
    if (grandParent && grandParent !== document.body && directChildren.length === 1) {
      const wrappers = Array.from(grandParent.children).filter(el => isVisible(el));
      if (wrappers.length >= 2 && wrappers.length <= 20) {
        const extracted = [];
        for (const wrap of wrappers) {
          const inner = wrap.querySelector(candidate.tagName.toLowerCase());
          if (inner && isVisible(inner)) extracted.push(inner);
        }
        const idx = extracted.indexOf(candidate);
        if (extracted.length >= 2 && idx !== -1) {
          return {
            groupEl: grandParent,
            options: extracted,
            index: idx
          };
        }
      }
    }

    return null;
  }

  function getCustomOptionLabel(el, index, total) {
    const text = cleanText(el.innerText || el.textContent, 240);
    if (text) return text;

    const attrLabel =
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('data-label') ||
      el.getAttribute('data-text') ||
      el.getAttribute('data-val') ||
      el.getAttribute('data-value');
    if (attrLabel) return cleanText(attrLabel, 200);

    return `选项 ${index + 1}/${total}`;
  }

  function getCustomOptionValue(el, index) {
    const attrs = ['data-val', 'data-value', 'data-score', 'data-option', 'data-choice', 'data-answer', 'data-key', 'value'];
    for (const attr of attrs) {
      const val = el.getAttribute(attr);
      if (val !== null && val !== '') return cleanText(val, 120);
    }
    return String(index);
  }

  function isOptionSelectedVisually(el) {
    if (!el || !el.isConnected) return false;
    if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true') {
      return true;
    }
    return RE_SELECTED_CLASS.test(String(el.className || ''));
  }

  function classifyButtonIntent(candidate, text) {
    const cleaned = cleanText(text, 120);
    if (!cleaned) return 'unknown';

    if (CUSTOM_CONFIG.submitSelector && matchesOptionalSelector(candidate, CUSTOM_CONFIG.submitSelector)) {
      return 'submit';
    }
    if (RE_RESTART.test(cleaned)) {
      return 'restart';
    }
    if (cleaned.length <= 28 && RE_SUBMIT.test(cleaned)) {
      return 'submit';
    }
    if (cleaned.length <= 20 && RE_NAV_OR_UTIL.test(cleaned)) {
      return 'nav';
    }
    // Check stripped symbols like "下一题 ▶" or "◀ 上一题"
    const stripped = cleaned.replace(/[▶◀►◄→←»«>✓✔✕✖•·\s]+/g, '');
    if (stripped && stripped.length <= 16) {
      if (RE_RESTART.test(stripped)) return 'restart';
      if (RE_SUBMIT.test(stripped)) return 'submit';
      if (RE_NAV_OR_UTIL.test(stripped)) return 'nav';
    }
    return 'candidate';
  }

  function handleCustomOptionClick(candidate) {
    if (!candidate || isIgnoredElement(candidate)) return;

    const rawText = cleanText(candidate.innerText || candidate.textContent, 240);
    const intent = classifyButtonIntent(candidate, rawText);

    if (intent === 'restart') {
      resetSession(true);
      return;
    }

    if (intent === 'submit') {
      onSubmitSignal(candidate.closest('form') || document);
      return;
    }

    if (intent === 'nav') {
      // On navigation clicks, check if a result screen pops up shortly afterwards.
      if (Object.keys(state.answers).length > 0) {
        scheduleResultCheck(300);
      }
      return;
    }

    if (isLikelyHeaderOrChrome(candidate)) return;

    const groupInfo = findSiblingOptionGroup(candidate);
    if (!groupInfo) return;

    // Exclude groups where most siblings are navigation/action buttons (e.g. .btn-row with "上一题" + "下一题").
    const navSiblingCount = groupInfo.options.filter(opt => {
      const t = cleanText(opt.innerText || opt.textContent, 80);
      const kind = classifyButtonIntent(opt, t);
      return kind === 'nav' || kind === 'submit' || kind === 'restart';
    }).length;
    if (navSiblingCount >= Math.ceil(groupInfo.options.length / 2)) {
      return;
    }

    const allOptions = groupInfo.options.map((opt, idx) =>
      getCustomOptionLabel(opt, idx, groupInfo.options.length)
    );
    const selectedLabel = allOptions[groupInfo.index];
    const selectedValue = getCustomOptionValue(candidate, groupInfo.index);

    const ctx = findQuestionContext(groupInfo.groupEl, allOptions);
    const groupHint = `${groupInfo.groupEl.className || ''} ${groupInfo.groupEl.id || ''} ${groupInfo.groupEl.getAttribute('role') || ''}`;
    const candidateHint = `${candidate.className || ''} ${candidate.id || ''}`;
    const hasExplicitOptionCue =
      Boolean(CUSTOM_CONFIG.optionSelector && matchesOptionalSelector(candidate, CUSTOM_CONFIG.optionSelector)) ||
      RE_OPT_HINT.test(groupHint) ||
      RE_OPT_HINT.test(candidateHint) ||
      candidate.hasAttribute('data-val') ||
      candidate.hasAttribute('data-value') ||
      candidate.hasAttribute('data-score') ||
      candidate.hasAttribute('data-option') ||
      candidate.hasAttribute('onclick');

    // Require either a question prompt or explicit option cues so random page links/tabs aren't miscounted.
    if (!ctx.question && !hasExplicitOptionCue) return;

    lastActiveQuestionContainer = ctx.container || groupInfo.groupEl;

    const normalizedQ = normalizeKeyPart(ctx.question);
    const key = ctx.order && normalizedQ
      ? `q:${ctx.order}:${normalizedQ}`
      : normalizedQ
        ? `q:${normalizedQ}`
        : `grp:${getGroupUid(groupInfo.groupEl)}`;

    const preClickQuestionSnapshot = ctx.question;

    recordAnswer({
      key,
      order: ctx.order,
      totalQuestions: ctx.totalQuestions,
      question: ctx.question || `第 ${ctx.order || state.answerSequence + 1} 题`,
      answer: selectedLabel,
      values: [selectedValue],
      selectedOptions: [selectedLabel],
      allOptions,
      inputType: 'button'
    });

    // Post-click check (70ms): handle multi-select button groups & auto-advance completion transitions.
    setTimeout(() => {
      try {
        if (groupInfo.groupEl.isConnected && isVisible(groupInfo.groupEl)) {
          const postCtx = findQuestionContext(groupInfo.groupEl, allOptions);
          // Only inspect multi-select state if the question did NOT advance to a new question.
          if (postCtx.question === preClickQuestionSnapshot) {
            const activeOptions = groupInfo.options
              .map((opt, idx) => ({ opt, idx }))
              .filter(item => isOptionSelectedVisually(item.opt));

            if (activeOptions.length > 1) {
              const labels = activeOptions.map(item => allOptions[item.idx]);
              const vals = activeOptions.map(item => getCustomOptionValue(item.opt, item.idx));
              recordAnswer({
                key,
                order: ctx.order,
                totalQuestions: ctx.totalQuestions,
                question: ctx.question || `第 ${ctx.order || state.answerSequence} 题`,
                answer: labels.join('、'),
                values: vals,
                selectedOptions: labels,
                allOptions,
                inputType: 'multi-button'
              });
            }
          }
        }
        scheduleResultCheck(260);
      } catch {
        // ignore
      }
    }, 70);
  }

  // ---- Result Detection & Structured Extraction ----

  function extractMetricsFromResult(resultEl, cleanTextContent) {
    const metrics = [];
    const seen = new Set();

    function addMetric(label, value, max, display) {
      const cleanLabel = cleanText(label, 60).replace(/[:：\-\s]+$/, '');
      if (!cleanLabel || cleanLabel.length > 40) return;
      const key = cleanLabel.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      metrics.push({
        key: cleanLabel,
        label: cleanLabel,
        value: Number.isFinite(Number(value)) ? Number(value) : null,
        max: Number.isFinite(Number(max)) ? Number(max) : null,
        display: cleanText(display, 40)
      });
    }

    // 1. Scan explicit key:value score/percentage patterns in text (e.g., "攻度: 70%", "猎奇指数: 45/100", "外向: 82分").
    const lines = cleanTextContent.split('\n');
    for (const line of lines) {
      const regex = /([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9\s/]{0,18}?)\s*[:：]\s*(\d+(?:\.\d+)?)\s*(%|\/\s*(\d+(?:\.\d+)?)|分|pts?)?/g;
      let match;
      while ((match = regex.exec(line)) !== null) {
        const label = cleanText(match[1], 40);
        const val = Number(match[2]);
        const unit = match[3] || '';
        const explicitMax = match[4] ? Number(match[4]) : null;
        if (!label || !Number.isFinite(val)) continue;
        // Skip dates/times/question counters like "2026:01" or "第 1 题"
        if (/^(http|https|第|共|时间|日期)/i.test(label)) continue;
        if (!unit && val > 1000) continue;
        const max = explicitMax || (unit === '%' ? 100 : val <= 100 ? 100 : null);
        addMetric(label, val, max, `${val}${unit}`);
      }
    }

    // 2. Scan progress/meter elements inside resultEl.
    if (resultEl && resultEl.querySelectorAll) {
      const bars = resultEl.querySelectorAll('progress, meter, [class*="bar-fill"], [class*="progress-fill"]');
      for (const bar of bars) {
        if (metrics.length >= 25) break;
        const row = bar.closest('.score, .metric, .dim, .dimension, .stat, .item, .row, li, tr') || bar.parentElement?.parentElement;
        if (!row || row === resultEl) continue;

        let val = null;
        let max = 100;
        if (bar.tagName === 'PROGRESS' || bar.tagName === 'METER') {
          val = Number(bar.value);
          max = Number(bar.max) || 100;
        } else {
          const widthMatch = String(bar.style.width || '').match(/(\d+(?:\.\d+)?)%/);
          if (widthMatch) val = Number(widthMatch[1]);
        }
        if (val === null || !Number.isFinite(val)) continue;

        const rowText = cleanText(row.innerText || row.textContent, 80);
        const label = rowText.replace(/\d+(?:\.\d+)?\s*(?:%|\/\d+|分)?/g, '').trim();
        if (label && label.length >= 2 && label.length <= 24) {
          addMetric(label, val, max, max === 100 ? `${val}%` : `${val}/${max}`);
        }
      }
    }

    return metrics.slice(0, 30);
  }

  function extractStructuredSummary(resultEl) {
    const clone = resultEl.cloneNode(true);
    clone
      .querySelectorAll('script, style, noscript, canvas, svg, button, .btn-row, .actions, .disclaimer, [class*="restart"], [class*="copy"], [class*="share"]')
      .forEach(node => node.remove());

    const fullText = cleanMultilineText(clone.innerText || clone.textContent || '', 6000);
    const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);

    function pickFirstText(selectors, maxLen, excludeSet) {
      for (const sel of selectors) {
        try {
          const el = resultEl.querySelector(sel);
          if (!el || !isVisible(el)) continue;
          const text = cleanText(el.innerText || el.textContent, maxLen);
          if (text && (!excludeSet || !excludeSet.has(text))) {
            return text;
          }
        } catch {
          // ignore
        }
      }
      return '';
    }

    const used = new Set();

    const headline = pickFirstText(
      [
        ...(CUSTOM_CONFIG.scoreSelector ? [CUSTOM_CONFIG.scoreSelector] : []),
        '[class*="result-code"]',
        '[class*="type-code"]',
        '[class*="final-score"]',
        '[class*="score-value"]',
        '[class*="score-num"]',
        '[class*="mbti"]',
        '[class*="grade"]',
        'h1',
        'h2'
      ],
      100,
      used
    ) || (lines[0] && lines[0].length <= 80 ? lines[0] : '');
    if (headline) used.add(headline);

    const title = pickFirstText(
      [
        '[class*="result-name"]',
        '[class*="result-title"]',
        '[class*="type-name"]',
        '[class*="personality-name"]',
        'h2',
        'h3'
      ],
      160,
      used
    );
    if (title) used.add(title);

    const subtitle = pickFirstText(
      [
        '[class*="slogan"]',
        '[class*="tagline"]',
        '[class*="subtitle"]',
        '[class*="result-sub"]',
        '[class*="brief"]'
      ],
      240,
      used
    );

    // Explicit score detection (e.g. "总分：88 / 100", "得分 92 分", "Score: 85%")
    let score = null;
    const scoreMatch =
      fullText.match(/(?:总分|得分|分数|成绩|测试结果|score|points?)\s*[:：]?\s*(\d+(?:\.\d+)?(?:\s*[/／]\s*\d+)?\s*(?:分|%|pts?)?)/i) ||
      fullText.match(/(\d+(?:\.\d+)?\s*[/／]\s*\d+)/);
    if (scoreMatch) {
      score = cleanText(scoreMatch[1], 40);
    }

    // Badges / tags
    const badgeSet = new Set();
    const tagNodes = resultEl.querySelectorAll('[class*="tag"], [class*="badge"], [class*="pill"], [class*="chip"]');
    for (const node of tagNodes) {
      if (!isVisible(node)) continue;
      if (node.querySelector('button, input')) continue;
      const text = cleanText(node.innerText || node.textContent, 60);
      if (text && text.length >= 2 && text.length <= 40) {
        badgeSet.add(text);
      }
      if (badgeSet.size >= 24) break;
    }

    const metrics = extractMetricsFromResult(resultEl, fullText);

    return {
      headline: headline || score || title || '已完成测试',
      title,
      subtitle,
      score,
      badges: Array.from(badgeSet),
      metrics,
      text: fullText
    };
  }

  function findVisibleResultContainer() {
    // 1. Custom selector takes top priority.
    if (CUSTOM_CONFIG.resultSelector) {
      try {
        const el = document.querySelector(CUSTOM_CONFIG.resultSelector);
        if (el && isVisible(el)) {
          const text = cleanText(el.innerText || el.textContent, 200);
          if (text.length >= 4) return el;
        }
      } catch {
        // ignore
      }
    }

    // 2. Semantic result containers.
    const candidates = document.querySelectorAll(
      '#scr-result, #result-card, #result, #results, #report, [id*="result"], [class*="result"], [id*="report"], [class*="report"], [class*="outcome"], [class*="score-card"], [class*="summary"], [class*="finish"]'
    );

    let bestEl = null;
    let bestScore = -1;

    for (const el of candidates) {
      if (!isVisible(el) || isIgnoredElement(el)) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'script') continue;
      // Ignore if this container still holds visible unanswered quiz options.
      const visibleRadios = Array.from(el.querySelectorAll('input[type="radio"]')).filter(isVisible);
      if (visibleRadios.length >= 2) continue;

      const text = cleanText(el.innerText || el.textContent, 600);
      if (text.length < 6) continue;
      if (RE_NAV_OR_UTIL.test(text) || RE_SUBMIT.test(text)) continue;

      let priority = 10;
      const idCls = `${el.id || ''} ${el.className || ''}`;
      if (/result-card|scr-result|final-result|quiz-result|test-result/i.test(idCls)) priority += 40;
      else if (RE_RESULT_HINT.test(idCls)) priority += 20;
      // Prefer tighter inner result card over whole screen wrapper if both exist.
      if (el.querySelector('#result-card, .result-card')) priority -= 15;
      priority += Math.min(text.length / 40, 20);

      if (priority > bestScore) {
        bestScore = priority;
        bestEl = el;
      }
    }

    if (bestEl) return bestEl;

    // 3. Fallback when submit was explicitly clicked OR question screen just disappeared.
    const recentlySubmitted = Date.now() - submitSignaledAt < 8000;
    const questionDisappeared = lastActiveQuestionContainer && !isVisible(lastActiveQuestionContainer);
    if (recentlySubmitted || questionDisappeared) {
      const mainArea = document.querySelector('main, #app, .container, .card') || document.body;
      if (mainArea && isVisible(mainArea)) {
        const hasVisibleOptions = mainArea.querySelectorAll('input[type="radio"], .opt-btn, .option').length > 0 &&
          Array.from(mainArea.querySelectorAll('input[type="radio"], .opt-btn, .option')).some(isVisible);
        const text = cleanText(mainArea.innerText || mainArea.textContent, 600);
        if (!hasVisibleOptions && text.length >= 16) {
          return mainArea;
        }
      }
    }

    return null;
  }

  function tryCaptureResult(options = {}) {
    const answersCount = Object.keys(state.answers).length;
    if (answersCount === 0 && !options.force) return false;

    const resultEl = findVisibleResultContainer();
    if (!resultEl) return false;

    const summary = extractStructuredSummary(resultEl);
    if (!summary.text && !summary.headline && !summary.score) return false;

    const wasCompleted = state.status === 'completed';
    state.status = 'completed';
    if (!state.completedAt) state.completedAt = new Date().toISOString();
    state.summary = summary;
    saveSessionState();
    sendPayload({ force: !wasCompleted });

    // Re-capture once after animations / async counters settle (e.g. score counting up).
    if (!options.isSettlePass) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        tryCaptureResult({ isSettlePass: true });
      }, 1200);
    }

    return true;
  }

  function scheduleResultCheck(delayMs = 280) {
    if (resultWatchTimer) clearTimeout(resultWatchTimer);
    resultWatchTimer = setTimeout(() => {
      resultWatchTimer = null;
      tryCaptureResult();
    }, delayMs);
  }

  function onSubmitSignal(formScope) {
    submitSignaledAt = Date.now();
    snapshotFormInputs(formScope);
    saveSessionState();
    sendPayload();
    scheduleResultCheck(260);
    setTimeout(() => tryCaptureResult(), 900);
  }

  // ---- Event Listeners (Capture Phase so we run BEFORE host SPA mutates DOM) ----

  document.addEventListener('change', event => {
    try {
      const target = event.target;
      if (!target || target.nodeType !== 1) return;
      if (target.matches('input, select, textarea')) {
        if (target.type === 'range') target.dataset.watchingTouched = '1';
        captureNativeInput(target);
      }
    } catch {
      // ignore
    }
  }, true);

  let rangeInputTimer = null;
  document.addEventListener('input', event => {
    try {
      const target = event.target;
      if (!target || target.nodeType !== 1) return;
      if (target.tagName === 'INPUT' && target.type === 'range') {
        target.dataset.watchingTouched = '1';
        if (rangeInputTimer) clearTimeout(rangeInputTimer);
        rangeInputTimer = setTimeout(() => captureNativeInput(target), 250);
      }
    } catch {
      // ignore
    }
  }, true);

  document.addEventListener('submit', event => {
    try {
      onSubmitSignal(event.target);
    } catch {
      // ignore
    }
  }, true);

  document.addEventListener('click', event => {
    try {
      const target = event.target;
      if (!target || target.nodeType !== 1) return;

      // Submit button associated with a real <form> or explicit submitSelector.
      const btn = target.closest('button, input[type="submit"], [role="button"]');
      const isRealFormSubmit = Boolean(btn && btn.form && btn.type === 'submit');
      const isCustomSubmit = Boolean(btn && CUSTOM_CONFIG.submitSelector && matchesOptionalSelector(btn, CUSTOM_CONFIG.submitSelector));
      if (isRealFormSubmit || isCustomSubmit) {
        onSubmitSignal(btn.form || document);
        return;
      }

      const candidate = findClickableCandidate(target);
      if (candidate) {
        handleCustomOptionClick(candidate);
      }
    } catch {
      // ignore
    }
  }, true);

  document.addEventListener('keydown', event => {
    try {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target;
      if (!target || target.nodeType !== 1) return;
      if (target.matches('input, textarea, select')) return;
      const candidate = findClickableCandidate(target);
      if (candidate) {
        handleCustomOptionClick(candidate);
      }
    } catch {
      // ignore
    }
  }, true);

  // Passive window.alert observer (for simple quizzes that only alert("你的得分: 85分")).
  if (typeof window.alert === 'function') {
    const nativeAlert = window.alert.bind(window);
    window.alert = function patchedAlert(message) {
      try {
        const text = cleanText(message, 1000);
        if (text && Object.keys(state.answers).length > 0 && !/(已复制|复制失败|请选择|请先|未完成|please select)/i.test(text)) {
          const scoreMatch = text.match(/(\d+(?:\.\d+)?(?:\s*[/／]\s*\d+)?\s*(?:分|%|pts?)?)/i);
          state.status = 'completed';
          if (!state.completedAt) state.completedAt = new Date().toISOString();
          state.summary = {
            headline: scoreMatch ? cleanText(scoreMatch[1], 60) : text.slice(0, 60),
            title: '',
            subtitle: '',
            score: scoreMatch ? cleanText(scoreMatch[1], 40) : null,
            badges: [],
            metrics: extractMetricsFromResult(null, text),
            text
          };
          saveSessionState();
          sendPayload({ force: true });
        }
      } catch {
        // ignore
      }
      return nativeAlert(message);
    };
  }

  // Observe DOM changes to automatically detect result screen rendering.
  function startDomObserver() {
    if (!document.body || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (Object.keys(state.answers).length > 0) {
        scheduleResultCheck(300);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
    });

    // Handle multi-page static quizzes where the visitor lands directly on result.html with answers in sessionStorage.
    if (Object.keys(state.answers).length > 0) {
      scheduleResultCheck(400);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
  } else {
    startDomObserver();
  }

  window.addEventListener('hashchange', () => {
    if (Object.keys(state.answers).length > 0) scheduleResultCheck(300);
  });

  window.addEventListener('popstate', () => {
    if (Object.keys(state.answers).length > 0) scheduleResultCheck(300);
  });

  window.addEventListener('pagehide', () => {
    snapshotFormInputs(document);
    saveSessionState();
    sendPayload({ beacon: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      snapshotFormInputs(document);
      saveSessionState();
      sendPayload({ beacon: true });
    }
  });

  // Expose optional programmatic API for debugging or power-user custom integrations.
  window.__WATCHING_COLLECTOR__ = {
    version: '2.0.0',
    quizId: QUIZ_ID,
    getState() {
      return buildPayload();
    },
    flush() {
      sendPayload({ force: true });
    },
    resetSession() {
      resetSession(true);
    },
    reportResult(customSummary, rawResult) {
      state.status = 'completed';
      state.collectorMode = 'custom';
      if (!state.completedAt) state.completedAt = new Date().toISOString();
      state.summary = {
        ...(state.summary || {}),
        ...(customSummary && typeof customSummary === 'object' ? customSummary : {})
      };
      if (rawResult && typeof rawResult === 'object') {
        state.rawResult = rawResult;
      }
      saveSessionState();
      sendPayload({ force: true });
    }
  };
})();
