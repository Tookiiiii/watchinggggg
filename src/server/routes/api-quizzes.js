import { isMonitorAuthorized } from '../auth.js';
import { parseRequestUrl, sendJson } from '../utils/http.js';

export async function handleQuizzesApi(req, res, { config, registry, storage, bypassAuth = false }) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, { Allow: 'GET' });
    return;
  }

  const url = parseRequestUrl(req, config.host);
  const authorized = isMonitorAuthorized(req, config, { bypassAuth });
  const includeAdminStats = authorized && url.searchParams.get('includeStats') !== '0';

  const quizzes = await registry.list({ forceRefresh: url.searchParams.get('refresh') === '1' });
  const visibleQuizzes = authorized ? quizzes : quizzes.filter(item => !item.hidden);

  let statsByQuiz = new Map();
  if (includeAdminStats && storage) {
    const records = await storage.listRecords();
    for (const record of records) {
      const current = statsByQuiz.get(record.quizId) || {
        totalRecords: 0,
        completedRecords: 0,
        inProgressRecords: 0,
        latestAt: null
      };
      current.totalRecords += 1;
      if (record.status === 'completed') current.completedRecords += 1;
      else current.inProgressRecords += 1;
      if (!current.latestAt || (record.updatedAt && record.updatedAt > current.latestAt)) {
        current.latestAt = record.updatedAt || record.createdAt || null;
      }
      statsByQuiz.set(record.quizId, current);
    }
  }

  const items = visibleQuizzes.map(quiz => {
    const summary = registry.toPublicSummary(quiz);
    if (!includeAdminStats) {
      return {
        slug: summary.slug,
        title: summary.title,
        description: summary.description,
        mountPath: summary.mountPath
      };
    }
    const stats = statsByQuiz.get(quiz.slug) || {
      totalRecords: 0,
      completedRecords: 0,
      inProgressRecords: 0,
      latestAt: null
    };
    return {
      ...summary,
      stats
    };
  });

  sendJson(res, 200, {
    ok: true,
    quizzes: items
  });
}
