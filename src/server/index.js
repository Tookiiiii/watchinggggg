import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppContext, createAppHandler, createMonitorOnlyHandler } from './app.js';
import { sendJson } from './utils/http.js';

export async function startServers(configOverrides = {}) {
  const context = createAppContext(configOverrides);
  const { config, registry } = context;

  const mainHandler = createAppHandler(context);
  const appServer = createServer((req, res) => {
    mainHandler(req, res).catch(error => {
      console.error('[server] unhandled error:', error);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
      }
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    appServer.once('error', rejectListen);
    appServer.listen(config.port, config.host, () => {
      appServer.off('error', rejectListen);
      resolveListen();
    });
  });

  let monitorServer = null;
  if (config.monitorPort && config.monitorPort !== config.port) {
    const monitorHandler = createMonitorOnlyHandler(context);
    monitorServer = createServer((req, res) => {
      monitorHandler(req, res).catch(error => {
        console.error('[monitor] unhandled error:', error);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
        }
      });
    });

    await new Promise((resolveListen, rejectListen) => {
      monitorServer.once('error', rejectListen);
      monitorServer.listen(config.monitorPort, config.host, () => {
        monitorServer.off('error', rejectListen);
        resolveListen();
      });
    });
  }

  const quizzes = await registry.list({ forceRefresh: true });
  return { context, appServer, monitorServer, quizzes };
}

const isDirectRun = Boolean(
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);

if (isDirectRun) {
  startServers()
    .then(({ context, quizzes, monitorServer }) => {
      const { config, storage } = context;
      const baseUrl = `http://${config.host}:${config.port}`;
      console.log('');
      console.log(`Watching Server running at ${baseUrl}/`);
      console.log(`  Portal:   ${baseUrl}/`);
      console.log(`  Monitor:  ${baseUrl}/monitor/`);
      if (monitorServer) {
        console.log(`  Monitor2: http://${config.host}:${config.monitorPort}/`);
      }
      console.log(`  Storage:  ${storage.getBackendInfo().type} (${storage.getBackendInfo().location})`);
      console.log(`  Auth:     ${config.monitorPassword ? 'MONITOR_PASSWORD enabled' : 'open (set MONITOR_PASSWORD to lock)'}`);
      console.log(`  Quizzes:  ${quizzes.length} discovered in ${config.quizzesDir}`);
      for (const quiz of quizzes) {
        console.log(`    - ${quiz.slug} -> ${baseUrl}${quiz.mountPath} (${quiz.title})`);
      }
      console.log('');
    })
    .catch(error => {
      console.error('Failed to start server:', error);
      process.exit(1);
    });
}
