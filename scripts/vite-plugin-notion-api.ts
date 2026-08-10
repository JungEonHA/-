/**
 * 개발/프리뷰 서버에서 `/api/*` 를 처리하는 Vite 플러그인.
 *
 * 배포(Vercel 서버리스)와 **완전히 동일한 라우터**를 사용하므로,
 * 로컬에서 통과한 동작이 배포에서도 그대로 동작한다.
 */

import type { Connect, Plugin, ViteDevServer, PreviewServer } from 'vite';
import { loadEnv } from 'vite';
import { handleApiRequest, type ServerEnv } from '../api/_router';

function readBody(req: Connect.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function makeMiddleware(env: ServerEnv): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '/';
    if (!rawUrl.startsWith('/api/') && rawUrl !== '/api') return next();

    const url = new URL(rawUrl, 'http://localhost');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);

    const result = await handleApiRequest(
      {
        method: req.method ?? 'GET',
        path: url.pathname.replace(/^\/api/, '') || '/',
        query,
        headers,
        body,
      },
      { env },
    );

    res.statusCode = result.status;
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    res.end(result.body === null ? undefined : JSON.stringify(result.body));
  };
}

function collectEnv(mode: string, root: string): ServerEnv {
  // 접두사 '' -> .env 의 모든 키를 읽는다 (VITE_ 없는 서버 전용 값 포함).
  // 이 값들은 플러그인(=Node 프로세스) 안에서만 쓰이고 번들에 주입되지 않는다.
  const fileEnv = loadEnv(mode, root, '');
  const pick = (k: string) => process.env[k] ?? fileEnv[k];
  return {
    NOTION_TOKEN: pick('NOTION_TOKEN'),
    NOTION_DATABASE_ID: pick('NOTION_DATABASE_ID'),
    NOTION_VERSION: pick('NOTION_VERSION'),
    NOTION_ALLOW_WRITE: pick('NOTION_ALLOW_WRITE'),
    APP_ACCESS_KEY: pick('APP_ACCESS_KEY'),
    ALLOWED_ORIGINS: pick('ALLOWED_ORIGINS'),
  };
}

export function notionDevApiPlugin(): Plugin {
  let env: ServerEnv = {};
  return {
    name: 'notion-dev-api',
    configResolved(config) {
      env = collectEnv(config.mode, config.root);
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use(makeMiddleware(env));
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(makeMiddleware(env));
    },
  };
}
