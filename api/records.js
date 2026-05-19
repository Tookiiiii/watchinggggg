import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const recordsKey = 'asti:records';
const maxRecords = Number(process.env.MAX_RECORDS || 1000);
const redis = Redis.fromEnv();

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
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
    ip: scrubText(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '', 100),
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

function isAuthorized(req) {
  const password = process.env.MONITOR_PASSWORD;
  if (!password) return false;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${password}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const record = normalizeAnswerRecord(body, req);
      await redis.lpush(recordsKey, JSON.stringify(record));
      await redis.ltrim(recordsKey, 0, Math.max(0, maxRecords - 1));
      res.status(201).json({ ok: true, id: record.id });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'Failed to save record' });
    }
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    const rows = await redis.lrange(recordsKey, 0, maxRecords - 1);
    const records = rows
      .map(row => {
        if (typeof row === 'string') {
          try {
            return JSON.parse(row);
          } catch {
            return null;
          }
        }
        return row;
      })
      .filter(Boolean);
    res.status(200).json({ records });
    return;
  }

  if (req.method === 'DELETE') {
    await redis.del(recordsKey);
    res.status(200).json({ ok: true });
    return;
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
