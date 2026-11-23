import crypto from 'node:crypto';
import { getClientIp } from '../utils/http.js';

const LEGACY_ASTI_DIMS = {
  D: '支配倾向',
  O: '开放程度',
  K: '猎奇指数',
  R: '浪漫需求',
  L: '欲望强度',
  E: '表现欲望',
  F: '幻想倾向',
  A: '情感依恋',
  G: '性别弹性',
  T: '道具兴趣'
};

export function scrubText(value, maxLength = 4000) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function toSafeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toIsoOrFallback(value, fallback) {
  if (!value) return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function normalizeMetrics(rawMetrics) {
  if (Array.isArray(rawMetrics)) {
    return rawMetrics
      .filter(item => item && typeof item === 'object')
      .slice(0, 40)
      .map(item => {
        const value = toSafeNumber(item.value);
        const max = toSafeNumber(item.max);
        return {
          key: scrubText(item.key || item.label, 60),
          label: scrubText(item.label || item.key, 80),
          value,
          max: max ?? (value !== null && value >= 0 && value <= 100 ? 100 : null),
          display: scrubText(item.display ?? (value !== null ? String(value) : ''), 60)
        };
      })
      .filter(item => item.label);
  }

  if (rawMetrics && typeof rawMetrics === 'object') {
    return Object.entries(rawMetrics)
      .slice(0, 40)
      .map(([key, rawVal]) => {
        const value = toSafeNumber(rawVal);
        return {
          key: scrubText(key, 60),
          label: scrubText(LEGACY_ASTI_DIMS[key] || key, 80),
          value,
          max: value !== null && value >= 0 && value <= 100 ? 100 : null,
          display: scrubText(rawVal, 60)
        };
      });
  }

  return [];
}

function normalizeAnswers(rawAnswers) {
  if (!Array.isArray(rawAnswers)) return [];
  return rawAnswers
    .filter(item => item && typeof item === 'object')
    .slice(0, 500)
    .map((item, idx) => {
      const selectedOptions = Array.isArray(item.selectedOptions)
        ? item.selectedOptions.map(v => scrubText(v, 300)).filter(Boolean).slice(0, 30)
        : [];
      const values = Array.isArray(item.values)
        ? item.values.map(v => scrubText(v, 200)).filter(Boolean).slice(0, 30)
        : item.value !== undefined && item.value !== null && item.value !== ''
          ? [scrubText(item.value, 200)]
          : item.answer !== undefined && item.answer !== null && item.answer !== '' && !selectedOptions.length
            ? [scrubText(item.answer, 200)]
            : [];

      const answerText = scrubText(
        item.answer ?? item.answerLabel ?? (selectedOptions.length ? selectedOptions.join('、') : values.join('、')),
        600
      );

      return {
        key: scrubText(item.key || `q_${idx + 1}`, 160),
        order: toSafeNumber(item.order) ?? idx + 1,
        question: scrubText(item.question ?? item.text ?? `第 ${idx + 1} 题`, 600),
        answer: answerText,
        values,
        selectedOptions: selectedOptions.length ? selectedOptions : answerText ? [answerText] : [],
        allOptions: Array.isArray(item.allOptions)
          ? item.allOptions.map(v => scrubText(v, 200)).filter(Boolean).slice(0, 30)
          : [],
        inputType: scrubText(item.inputType || 'custom', 30) || 'custom',
        changeCount: Math.max(1, toSafeNumber(item.changeCount) || 1),
        answeredAt: toIsoOrFallback(item.answeredAt, null)
      };
    });
}

function normalizeLegacyAstiPayload(body, meta) {
  const result = body?.result && typeof body.result === 'object' ? body.result : {};
  const analysis = body?.analysis && typeof body.analysis === 'object' ? body.analysis : {};
  const questions = Array.isArray(body?.questions) ? body.questions : [];

  const badges = [];
  if (analysis.roleLabel) {
    const atkSuffix = analysis.atkPct !== null && analysis.atkPct !== undefined ? ` / 攻度 ${analysis.atkPct}%` : '';
    badges.push(scrubText(`${analysis.roleLabel}${atkSuffix}`, 100));
  }
  if (analysis.orientBrief) badges.push(scrubText(analysis.orientBrief, 120));
  if (analysis.kinkLvBrief) badges.push(scrubText(analysis.kinkLvBrief, 120));
  if (Array.isArray(analysis.kinkSubs)) {
    for (const sub of analysis.kinkSubs.slice(0, 30)) {
      const cleaned = scrubText(sub, 80);
      if (cleaned) badges.push(cleaned);
    }
  }

  const answers = questions.slice(0, 300).map((q, idx) => {
    const label = scrubText(q.answerLabel || q.answer, 100);
    const val = q.answer !== undefined && q.answer !== null ? String(q.answer) : '';
    return {
      key: `legacy_${q.index ?? idx}`,
      order: toSafeNumber(q.order) ?? idx + 1,
      question: scrubText(q.text, 600),
      answer: label,
      values: val ? [val] : [],
      selectedOptions: label ? [label] : [],
      allOptions: [],
      inputType: 'legacy',
      changeCount: 1,
      answeredAt: null
    };
  });

  const now = meta.createdAt || new Date().toISOString();
  const titleParts = [scrubText(result.cn, 80), scrubText(result.en, 80)].filter(Boolean);

  return {
    schemaVersion: 2,
    id: meta.id || crypto.randomUUID(),
    sessionId: meta.sessionId || meta.id || crypto.randomUUID(),
    quizId: scrubText(body.quizId || 'asti', 100) || 'asti',
    quizTitle: scrubText(body.quizTitle || 'ASTI · 涩涩人格测试', 160),
    pagePath: scrubText(body.pagePath || '/q/asti/', 300),
    status: 'completed',
    collectorMode: 'legacy',
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    durationMs: null,
    ip: meta.ip || '',
    userAgent: meta.userAgent || '',
    totalQuestions: answers.length || null,
    answeredCount: answers.length,
    summary: {
      headline: scrubText(result.code, 80),
      title: titleParts.join(' · '),
      subtitle: scrubText(result.slogan, 200),
      score: null,
      badges,
      metrics: normalizeMetrics(body.scores),
      text: scrubText(result.desc, 4000)
    },
    answers,
    rawResult: {
      legacy: true,
      result,
      analysis
    }
  };
}

export function normalizeIncomingRecord(body, req) {
  const now = new Date().toISOString();
  const ip = req ? getClientIp(req) : scrubText(body?.ip || '', 100);
  const userAgent = req ? scrubText(req.headers?.['user-agent'] || '', 500) : scrubText(body?.userAgent || '', 500);

  // Backwards compatibility for legacy v1 ASTI payloads.
  const isLegacyPayload =
    body &&
    typeof body === 'object' &&
    body.schemaVersion !== 2 &&
    !Array.isArray(body.answers) &&
    (Array.isArray(body.questions) || (body.result && typeof body.result === 'object' && body.scores));

  if (isLegacyPayload) {
    return normalizeLegacyAstiPayload(body, { ip, userAgent, createdAt: now });
  }

  const safeBody = body && typeof body === 'object' ? body : {};
  const rawSummary = safeBody.summary && typeof safeBody.summary === 'object' ? safeBody.summary : {};
  const answers = normalizeAnswers(safeBody.answers);

  const status = safeBody.status === 'completed' ? 'completed' : 'in_progress';
  const startedAt = toIsoOrFallback(safeBody.startedAt, now);
  const completedAt = status === 'completed' ? toIsoOrFallback(safeBody.completedAt, now) : null;

  let durationMs = toSafeNumber(safeBody.durationMs);
  if (durationMs === null && startedAt) {
    const endMs = Date.parse(completedAt || now);
    const startMs = Date.parse(startedAt);
    if (Number.isFinite(endMs) && Number.isFinite(startMs) && endMs >= startMs) {
      durationMs = Math.min(endMs - startMs, 24 * 60 * 60 * 1000);
    }
  }

  const totalQuestions = toSafeNumber(safeBody.totalQuestions);
  const answeredCount = answers.length || Math.max(0, toSafeNumber(safeBody.answeredCount) || 0);

  const badges = Array.isArray(rawSummary.badges)
    ? Array.from(new Set(rawSummary.badges.map(b => scrubText(b, 80)).filter(Boolean))).slice(0, 30)
    : [];

  return {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    sessionId: scrubText(safeBody.sessionId || crypto.randomUUID(), 120),
    quizId: scrubText(safeBody.quizId || 'unknown', 100) || 'unknown',
    quizTitle: scrubText(safeBody.quizTitle || safeBody.quizId || '未命名测试', 160),
    pagePath: scrubText(safeBody.pagePath || '', 300),
    status,
    collectorMode: scrubText(safeBody.collectorMode || 'auto', 30) || 'auto',
    startedAt,
    createdAt: now,
    updatedAt: now,
    completedAt,
    durationMs,
    ip,
    userAgent,
    totalQuestions: totalQuestions && totalQuestions > 0 ? totalQuestions : null,
    answeredCount,
    summary: {
      headline: scrubText(rawSummary.headline, 120),
      title: scrubText(rawSummary.title, 200),
      subtitle: scrubText(rawSummary.subtitle, 300),
      score: rawSummary.score !== null && rawSummary.score !== undefined ? scrubText(rawSummary.score, 60) : null,
      badges,
      metrics: normalizeMetrics(rawSummary.metrics),
      text: scrubText(rawSummary.text, 6000)
    },
    answers,
    rawResult: safeBody.rawResult && typeof safeBody.rawResult === 'object' ? safeBody.rawResult : null
  };
}

export function upgradeStoredRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.schemaVersion === 2) {
    return record;
  }
  return normalizeLegacyAstiPayload(record, {
    id: record.id || crypto.randomUUID(),
    sessionId: record.sessionId || record.id || crypto.randomUUID(),
    createdAt: record.createdAt || new Date().toISOString(),
    ip: scrubText(record.ip || '', 100),
    userAgent: scrubText(record.userAgent || '', 500)
  });
}

export function mergeRecordUpdate(existing, incoming) {
  if (!existing) return incoming;

  // Guard against out-of-order network delivery where a delayed in_progress beacon arrives after completion.
  if (
    existing.status === 'completed' &&
    incoming.status !== 'completed' &&
    incoming.answers.length <= existing.answers.length
  ) {
    return existing;
  }

  const nextStatus = existing.status === 'completed' || incoming.status === 'completed'
    ? 'completed'
    : 'in_progress';

  // Prefer the richer summary if incoming doesn't yet carry one.
  const hasIncomingSummary = Boolean(
    incoming.summary?.headline ||
    incoming.summary?.title ||
    incoming.summary?.score ||
    incoming.summary?.text ||
    (incoming.summary?.metrics && incoming.summary.metrics.length > 0)
  );

  // Merge answers by key so answers from earlier pages in a multi-page quiz are preserved.
  const answerMap = new Map();
  for (const ans of existing.answers || []) {
    answerMap.set(ans.key, ans);
  }
  for (const ans of incoming.answers || []) {
    answerMap.set(ans.key, ans);
  }
  const mergedAnswers = Array.from(answerMap.values()).sort((a, b) => (a.order || 0) - (b.order || 0));

  return {
    ...existing,
    ...incoming,
    id: existing.id,
    createdAt: existing.createdAt || incoming.createdAt,
    startedAt: existing.startedAt || incoming.startedAt,
    updatedAt: incoming.updatedAt || new Date().toISOString(),
    status: nextStatus,
    completedAt: incoming.completedAt || existing.completedAt || (nextStatus === 'completed' ? incoming.updatedAt : null),
    totalQuestions: incoming.totalQuestions || existing.totalQuestions || null,
    answeredCount: mergedAnswers.length,
    answers: mergedAnswers,
    summary: hasIncomingSummary ? incoming.summary : existing.summary,
    rawResult: incoming.rawResult || existing.rawResult
  };
}
