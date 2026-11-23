import { createAppContext, createAppHandler } from '../src/server/app.js';
import { sendJson } from '../src/server/utils/http.js';

const context = createAppContext({
  loadEnv: false
});
const appHandler = createAppHandler(context);

export default async function handler(req, res) {
  try {
    await appHandler(req, res);
  } catch (error) {
    console.error('[vercel] unhandled error:', error);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
    }
  }
}
