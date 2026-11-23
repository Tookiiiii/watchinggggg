import { isMonitorAuthorized } from '../auth.js';
import { normalizeIncomingRecord } from '../services/record-normalizer.js';
import { parseJsonBody, parseRequestUrl, sendJson } from '../utils/http.js';

export async function handleRecordsApi(req, res, { config, storage, bypassAuth = false }) {
  const url = parseRequestUrl(req, config.host);

  if (req.method === 'POST') {
    try {
      const body = await parseJsonBody(req, config.maxBodyBytes);
      const normalized = normalizeIncomingRecord(body, req);
      const { record, created } = await storage.upsertRecord(normalized);
      sendJson(res, created ? 201 : 200, {
        ok: true,
        id: record.id,
        sessionId: record.sessionId,
        status: record.status,
        created
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        ok: false,
        error: error.message || 'Failed to save record'
      });
    }
    return;
  }

  if (!isMonitorAuthorized(req, config, { bypassAuth })) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    const records = await storage.listRecords({
      quizId: url.searchParams.get('quizId') || '',
      status: url.searchParams.get('status') || '',
      search: url.searchParams.get('search') || '',
      limit: url.searchParams.get('limit') || ''
    });
    sendJson(res, 200, {
      ok: true,
      records,
      storage: storage.getBackendInfo()
    });
    return;
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    const quizId = url.searchParams.get('quizId');

    if (id) {
      const deleted = await storage.deleteRecord(id);
      sendJson(res, deleted ? 200 : 404, { ok: deleted });
      return;
    }

    const result = await storage.clearRecords({ quizId: quizId || '' });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  sendJson(
    res,
    405,
    { ok: false, error: 'Method Not Allowed' },
    { Allow: 'GET, POST, DELETE' }
  );
}
