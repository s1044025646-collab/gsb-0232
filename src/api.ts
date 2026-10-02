import http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './errors.ts';
import {
  confirmDraw,
  createEvent,
  forfeit,
  freezeRoster,
  getResult,
  importRoster,
} from './service.ts';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

export function createServer(db: DatabaseSync): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true });
      }

      const bodyText = method === 'POST' ? await readBody(req) : '';
      const body = bodyText ? JSON.parse(bodyText) : {};

      // POST /events {name, quota, seed, maxCandidates?, maxWeight?}
      if (method === 'POST' && parts.length === 1 && parts[0] === 'events') {
        return send(res, 201, createEvent(db, body));
      }

      const m = parts[0] === 'events' ? Number(parts[1]) : NaN;
      if (parts[0] === 'events' && !Number.isInteger(m)) {
        throw new ApiError('INVALID_INPUT', '活动 id 必须是整数', 400);
      }

      // POST /events/:id/rosters {candidates: [...]}
      if (method === 'POST' && parts[2] === 'rosters' && parts.length === 3) {
        return send(res, 201, importRoster(db, m, body.candidates));
      }
      // POST /events/:id/rosters/:version/freeze
      if (method === 'POST' && parts[2] === 'rosters' && parts[4] === 'freeze') {
        return send(res, 200, freezeRoster(db, m, Number(parts[3])));
      }
      // POST /events/:id/draws {version?}
      if (method === 'POST' && parts[2] === 'draws' && parts.length === 3) {
        const v = body.version === undefined ? undefined : Number(body.version);
        return send(res, 200, confirmDraw(db, m, v));
      }
      // POST /events/:id/forfeits {candidateId}
      if (method === 'POST' && parts[2] === 'forfeits' && parts.length === 3) {
        if (typeof body.candidateId !== 'string') {
          throw new ApiError('INVALID_INPUT', 'candidateId 必须是字符串', 400);
        }
        return send(res, 200, forfeit(db, m, body.candidateId));
      }
      // GET /events/:id/result
      if (method === 'GET' && parts[2] === 'result' && parts.length === 3) {
        return send(res, 200, getResult(db, m));
      }

      throw new ApiError('NOT_FOUND', `未匹配的路由: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.status, { error: { code: e.code, message: e.message } });
      }
      if (e instanceof SyntaxError) {
        return send(res, 400, { error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
      }
      const msg = e instanceof Error ? e.message : String(e);
      return send(res, 500, { error: { code: 'INTERNAL', message: msg } });
    }
  });
}

// port 传 0 时由系统分配空闲端口（默认行为）。
export function startServer(db: DatabaseSync, port = 0): Promise<{ port: number; close: () => void }> {
  const server = createServer(db);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ port: actual, close: () => server.close() });
    });
  });
}
