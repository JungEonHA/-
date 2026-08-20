/**
 * Vercel(Node) 서버리스 진입점. `/api/*` 전부를 공용 라우터로 넘긴다.
 *
 * 여기서만 process.env 를 읽는다 — Notion Secret 은 브라우저 번들에 절대 포함되지 않는다.
 */

import { handleApiRequest, type ApiRequest } from './_router.js';

interface NodeLikeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface NodeLikeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

export default async function handler(req: NodeLikeRequest, res: NodeLikeResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/^\/api/, '') || '/';

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k.toLowerCase()] = v;
    else if (Array.isArray(v) && v[0]) headers[k.toLowerCase()] = v[0];
  }

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const apiReq: ApiRequest = {
    method: req.method ?? 'GET',
    path,
    query,
    headers,
    body: typeof req.body === 'string' ? safeParse(req.body) : (req.body ?? {}),
  };

  const result = await handleApiRequest(apiReq, {
    env: {
      NOTION_TOKEN: process.env.NOTION_TOKEN,
      NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID,
      NOTION_VERSION: process.env.NOTION_VERSION,
      NOTION_ALLOW_WRITE: process.env.NOTION_ALLOW_WRITE,
      APP_ACCESS_KEY: process.env.APP_ACCESS_KEY,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
      VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
      WEBHOOK_WORKTIME_ID: process.env.WEBHOOK_WORKTIME_ID,
      WEBHOOK_WORKTIME_TOKEN: process.env.WEBHOOK_WORKTIME_TOKEN,
      DISCORD_USER_IDS: process.env.DISCORD_USER_IDS,
    },
  });

  res.statusCode = result.status;
  for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  res.end(result.body === null ? undefined : JSON.stringify(result.body));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
