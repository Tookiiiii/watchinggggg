import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeIncomingRecord } from '../src/server/services/record-normalizer.js';
import { FileStorage } from '../src/server/storage/file-storage.js';

test('FileStorage supports session upsert, out-of-order completion protection, legacy ASTI records, and delete/clear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watching-storage-'));
  const recordsFile = join(dir, 'records.jsonl');

  try {
    // Seed a legacy v1 ASTI record directly in JSONL.
    const legacyLine = JSON.stringify({
      id: 'legacy-1',
      createdAt: '2026-05-20T00:00:00.000Z',
      ip: '127.0.0.1',
      result: { code: 'MAST', cn: '掌控者', en: 'Master', slogan: '把手给我', desc: '旧版记录' },
      scores: { D: 80, O: 60 },
      analysis: { roleLabel: '偏攻', atkPct: 72, orientBrief: '双性', kinkLvBrief: '中等', kinkSubs: ['轻度'] },
      questions: [{ order: 1, index: 5, text: '旧题目', answer: 4, answerLabel: '完全符合' }]
    });
    await writeFile(recordsFile, `${legacyLine}\n`, 'utf8');

    const storage = new FileStorage(recordsFile, { maxRecords: 50 });

    // 1. Verify legacy record is seamlessly upgraded to v2 on read.
    let list = await storage.listRecords();
    assert.equal(list.length, 1);
    assert.equal(list[0].schemaVersion, 2);
    assert.equal(list[0].quizId, 'asti');
    assert.equal(list[0].summary.headline, 'MAST');
    assert.equal(list[0].summary.metrics[0].label, '支配倾向');
    assert.equal(list[0].answers[0].answer, '完全符合');

    // 2. Upsert an in_progress session, then complete it under the same sessionId.
    const progressRec = normalizeIncomingRecord({
      schemaVersion: 2,
      sessionId: 'sess-abc',
      quizId: 'survey',
      quizTitle: '生活问卷',
      status: 'in_progress',
      answers: [{ key: 'q1', order: 1, question: '作息？', answer: '早睡早起', inputType: 'radio' }]
    });
    const first = await storage.upsertRecord(progressRec);
    assert.equal(first.created, true);

    const completeRec = normalizeIncomingRecord({
      schemaVersion: 2,
      sessionId: 'sess-abc',
      quizId: 'survey',
      quizTitle: '生活问卷',
      status: 'completed',
      summary: { headline: '活力平衡型', score: '86/100', text: '最终结论' },
      answers: [
        { key: 'q1', order: 1, question: '作息？', answer: '深夜猫头鹰', inputType: 'radio', changeCount: 2 },
        { key: 'q2', order: 2, question: '饮品？', answer: '美式咖啡', inputType: 'select' }
      ]
    });
    const second = await storage.upsertRecord(completeRec);
    assert.equal(second.created, false);
    assert.equal(second.record.id, first.record.id);
    assert.equal(second.record.status, 'completed');
    assert.equal(second.record.answers.length, 2);
    assert.equal(second.record.answers[0].answer, '深夜猫头鹰');

    // 3. Stale out-of-order in_progress beacon must NOT overwrite completed state.
    const stale = await storage.upsertRecord(progressRec);
    assert.equal(stale.record.status, 'completed');
    assert.equal(stale.record.summary.headline, '活力平衡型');

    // 4. Filter by quizId & delete single record & clear by quizId.
    const surveyOnly = await storage.listRecords({ quizId: 'survey' });
    assert.equal(surveyOnly.length, 1);

    const deleted = await storage.deleteRecord('legacy-1');
    assert.equal(deleted, true);

    list = await storage.listRecords();
    assert.equal(list.length, 1);
    assert.equal(list[0].quizId, 'survey');

    await storage.clearRecords({ quizId: 'survey' });
    assert.equal((await storage.listRecords()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
