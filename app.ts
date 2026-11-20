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
const MEMO_LIMIT = 1024;

// A memoized GET /api/v3 reply: the exact serialized body bytes the normal
// send path would emit, plus the REST handler's own headers and status, so a
// repeat request can be answered without rebuilding views or re-serializing.
type MemoEntry = {
  status: number;
  buf: Buffer;
  headers: Readonly<Record<string, string>>;
};

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
  // Event-based collection instead of `for await` over the request stream:
  // the async-iterator machinery carries a per-chunk cost, and the push
  // benchmark sends many small packs, so that overhead adds up fast. Plain
  // 'data'/'end'/'error' listeners keep the same semantics for less work.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      reject(err);
    });
  });
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

  // Per-server memo of GET /api/v3 replies. The key must combine the raw
  // request target, the Host header, and the current viewer login: response
  // bodies embed the Host in pagination links and the viewer login in owner
  // fields, and the viewer can be adopted mid-run, so all three have to
  // partition the memo or a cached reply could leak another viewer's view.
  const memo = new Map<string, MemoEntry>();

  function memoKey(req: IncomingMessage): string {
    return `${req.url ?? ''}\n${req.headers.host ?? ''}\n${forge.viewerLogin ?? ''}`;
  }

  function sendCached(res: ServerResponse, entry: MemoEntry, requestId: string): void {
    // Same wire shape as sendJson, but the body is the stored Buffer: no
    // view rebuild and no re-serialization. The request id is fresh for
    // this request; the stored headers are the handler's own.
    res.writeHead(entry.status, {
      'content-type': JSON_TYPE,
      'content-length': entry.buf.length,
      'x-github-request-id': requestId,
      ...entry.headers,
    });
    res.end(entry.buf);
  }

  function memoStore(key: string, out: ApiRes): void {
    if (out.status !== 200 || out.body === undefined) return;
    if (memo.size >= MEMO_LIMIT) memo.clear(); // simple, bounded cap
    memo.set(key, {
      status: out.status,
      buf: Buffer.from(`${JSON.stringify(out.body)}\n`, 'utf8'),
      headers: { ...(out.headers ?? {}) },
    });
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = `req-${requestCounter}`;
    void (async (): Promise<void> => {
      try {
        // Fast path for memoized API reads, before any URL parsing: if this
        // exact raw target + host + viewer already produced a reply, serve
        // it straight from the memo and skip parsing, segment splitting and
        // routing entirely. This is safe because the memo only ever holds
        // replies the full flow produced for that exact combination, and
        // any mutation (a non-GET request) clears it before being handled.
        if ((req.method ?? 'GET').toUpperCase() === 'GET') {
          const rawUrl = req.url ?? '';
          if (rawUrl.startsWith('/api/v3')) {
            const queryAt = rawUrl.indexOf('?');
            const rawPath = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
            if ((rawPath === '/api/v3' || rawPath.startsWith('/api/v3/')) && authed(req)) {
              const hit = memo.get(memoKey(req));
              if (hit !== undefined) {
                sendCached(res, hit, requestId);
                return;
              }
            }
          }
        }

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

        // Total invalidation: every mutation arrives as a non-GET request,
        // so clearing the whole memo here — before the request is handled —
        // guarantees no memoized GET reply can outlive a state change.
        if (method !== 'GET') memo.clear();

        if (isApi) {
          // Memoized GET flow: a hit is served from the stored bytes; a
          // miss runs the handler as usual and stores the result if it
          // qualifies (GET, status 200, defined body).
          const key = method === 'GET' ? memoKey(req) : '';
          if (method === 'GET') {
            const hit = memo.get(key);
            if (hit !== undefined) {
              sendCached(res, hit, requestId);
              return;
            }
          }
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
          if (method === 'GET') memoStore(key, out);
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
