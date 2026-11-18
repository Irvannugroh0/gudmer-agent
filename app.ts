// app.ts — the forge's HTTP server: protocol discipline (JSON everywhere on the API, a
// request id on every reply, bearer-token auth, a 400 for malformed JSON) and routing
// between the surfaces. main.ts owns the entry <-> env lifecycle; this file is the server.
//
//   GET  /healthz                  the env's boot probe, no auth
//   *    /api/v3/...               REST v3 (rest.ts), auth required
//   POST /api/graphql              GraphQL v4 (graphql.ts), auth required
//   POST /mcp                      MCP over streamable HTTP (mcp.ts), auth required
//   *    /<owner>/<repo>.git/...   git smart HTTP (git.ts), auth required
//   *    anything else             404 {"message":"Not Found"}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, type ApiRes } from './rest.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { ...headers });
    res.end();
    return;
  }
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, ...headers });
  res.end(buf);
}

function sendApiRes(res: ServerResponse, out: ApiRes): void {
  sendJson(res, out.status, out.body, out.headers ?? {});
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function authed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true; // local development without a token configured
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expected}` || header === `token ${expected}`;
}

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment; // the common case needs no decoding
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = `req-${requestCounter}`;
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
        const method = (req.method ?? 'GET').toUpperCase();
        const baseHeaders = { 'x-github-request-id': requestId };

        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true }, baseHeaders);
          return;
        }

        const isApi = segments[0] === 'api' && segments[1] === 'v3';
        const isGraphql = url.pathname === '/api/graphql';
        const isMcp = url.pathname === '/mcp';
        const isGit = segments.length >= 2 && (segments[1] as string).endsWith('.git');

        if (!authed(req) && (isApi || isGraphql || isMcp || isGit)) {
          sendJson(res, 401, { message: 'Bad credentials' }, baseHeaders);
          return;
        }

        if (isApi) {
          let body: Record<string, unknown> | undefined;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                const parsed: unknown = JSON.parse(raw.toString('utf8'));
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
                body = parsed as Record<string, unknown>;
              } catch {
                sendJson(res, 400, { message: 'Malformed JSON in request body' }, baseHeaders);
                return;
              }
            }
          }
          const out = handleRest(forge, {
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body,
            host: req.headers.host ?? 'localhost',
          });
          sendApiRes(res, { ...out, headers: { ...baseHeaders, ...(out.headers ?? {}) } });
          return;
        }

        if (isMcp && method === 'POST') {
          const raw = await readBody(req);
          const answer = handleMcp(forge, raw.toString('utf8'));
          if (answer.body === undefined) {
            res.writeHead(answer.status, { ...baseHeaders });
            res.end();
          } else {
            sendJson(res, answer.status, answer.body, baseHeaders);
          }
          return;
        }

        if (isGraphql && method === 'POST') {
          const raw = await readBody(req);
          const answer = handleGraphql(forge, raw.toString('utf8'));
          sendJson(res, answer.status, answer.body, baseHeaders);
          return;
        }

        if (isGit) {
          const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const out = handleGit(forge, {
            method,
            segments,
            query: url.searchParams,
            gitProtocol: req.headers['git-protocol'] ?? '',
            body: raw,
          });
          res.writeHead(out.status, { 'content-type': out.contentType, 'content-length': out.body.length, ...baseHeaders });
          res.end(out.body);
          return;
        }

        // GraphQL lands in its own module in a later pass.
        sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` }, { 'x-github-request-id': requestId });
        else res.end();
      }
    })();
  });
}
