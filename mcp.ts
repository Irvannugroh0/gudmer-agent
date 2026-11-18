// mcp.ts — the MCP endpoint (POST /mcp, streamable HTTP, stateless). Speaks both protocol
// eras the suite accepts: the modern one (`server/discover` answers identity, capabilities
// and supported versions with no handshake) and the legacy handshake (`initialize` +
// `notifications/initialized`). The six tools github-mcp-server names — create_repo,
// get_repo, create_issue, list_issues, create_pull_request, merge_pull_request — operate
// on the same store as REST, so objects are identical across surfaces (ids included).
//
// Error discipline: a non-JSON body is HTTP 400 with JSON-RPC -32700; an unknown tool is
// -32602; an unknown method is -32601; a tool called without its required arguments
// answers a tool result with isError:true. tools/list is a module constant, so repeated
// answers are byte-identical.

import type { Forge, RepoRec, PullRec, IssueRec } from './store.ts';
import { mergeFileMaps } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

const SERVER_INFO = { name: 'gudmer-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DEFAULT_REVISION = '2025-11-25';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: 'object', properties, required: [...required] };
}

const OWNER_PROP = { type: 'string', description: 'The repository owner login.' } as const;
const REPO_PROP = { type: 'string', description: 'The repository name.' } as const;

/** The tool list: built once, so every tools/list answer is the same bytes. */
export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: schema(
      {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: schema({ owner: OWNER_PROP, repo: REPO_PROP }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: schema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    inputSchema: schema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch (or commit) to merge from.' },
        base: { type: 'string', description: 'The base branch to merge into.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: schema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
]);

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export interface McpAnswer {
  status: number;
  /** The JSON-RPC response object; absent for notifications (202, empty body). */
  body?: unknown;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): McpAnswer {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string): McpAnswer {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolOk(value: unknown): Json {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: isRecord(value) ? value : { value } };
}

function toolFail(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(args: Json, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function needRepo(forge: Forge, args: Json): RepoRec | null {
  return forge.resolve(str(args, 'owner'), str(args, 'repo')) ?? null;
}

/** A head ref as github-mcp-server sends it may carry an `owner:` prefix; strip it. */
function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

function callTool(forge: Forge, name: string, args: Json): Json {
  const tool = TOOL_BY_NAME.get(name);
  if (tool === undefined) throw new RpcFailure(-32602, `Unknown tool: ${name}`);
  const required = (tool.inputSchema.required as readonly string[] | undefined) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return toolFail(`Missing required argument: ${key}`);
  }
  switch (name) {
    case 'create_repo': {
      const created = forge.createRepo(str(args, 'name'), args.private === true, typeof args.description === 'string' ? args.description : null);
      if (created === 'duplicate') return toolFail(`Repository already exists: ${str(args, 'name')}`);
      return toolOk(repoJson(forge, created));
    }
    case 'get_repo': {
      const repo = needRepo(forge, args);
      if (repo === null) return toolFail(`Repository not found: ${str(args, 'owner')}/${str(args, 'repo')}`);
      return toolOk(repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = needRepo(forge, args);
      if (repo === null) return toolFail('Repository not found');
      const now = forge.nowIso();
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title: str(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: forge.nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(issue.number, issue);
      return toolOk(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo(forge, args);
      if (repo === null) return toolFail('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(forge, repo, issue));
      // The text carries the bare array (what a caller parses); structuredContent wraps it.
      return { content: [{ type: 'text', text: JSON.stringify(items) }], structuredContent: { issues: items } };
    }
    case 'create_pull_request': {
      const repo = needRepo(forge, args);
      if (repo === null) return toolFail('Repository not found');
      const headRef = stripOwnerPrefix(str(args, 'head'));
      const baseRef = stripOwnerPrefix(str(args, 'base')) || repo.defaultBranch;
      const headSha = forge.branchTip(repo, headRef);
      if (headSha === undefined) return toolFail(`Head branch not found: ${headRef}`);
      if (forge.branchTip(repo, baseRef) === undefined) return toolFail(`Base branch not found: ${baseRef}`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          return toolFail('A pull request already exists for this branch combination');
        }
      }
      const now = forge.nowIso();
      const pull: PullRec = {
        number: repo.nextNumber++,
        title: str(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef,
        baseRef,
        headShaAtCreate: headSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: forge.nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.set(pull.number, pull);
      return toolOk(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = needRepo(forge, args);
      if (repo === null) return toolFail('Repository not found');
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolFail(`Pull request not found: ${String(raw)}`);
      if (pull.merged) return toolOk(pullJson(forge, repo, pull));
      if (pull.state !== 'open') return toolFail('Pull request is not open');
      const baseTip = forge.branchTip(repo, pull.baseRef);
      const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
      if (baseTip === undefined) return toolFail('Base branch not found');
      const mb = forge.objects.mergeBase(baseTip, headTip);
      if (mb === null || mb === headTip) return toolFail('Pull request is not mergeable: nothing to merge');
      const mergedFiles = mergeFileMaps(forge.filesAt(mb), forge.filesAt(baseTip), forge.filesAt(headTip));
      if (mergedFiles === null) return toolFail('Pull request is not mergeable: merge conflict');
      const tree = forge.objects.treeFromFiles(mergedFiles);
      const login = forge.viewerLogin ?? 'forge';
      const commitSha = forge.objects.commit({
        tree,
        parents: [baseTip, headTip],
        message: `Merge pull request #${pull.number} from ${pull.headRef}`,
        authorName: login,
        authorEmail: `${login}@example.invalid`,
        timeSec: forge.nextCommitTime(),
      });
      repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = forge.nowIso();
      pull.mergeCommitSha = commitSha;
      pull.updatedAt = forge.nowIso();
      return toolOk(pullJson(forge, repo, pull));
    }
    default:
      throw new RpcFailure(-32602, `Unknown tool: ${name}`);
  }
}

class RpcFailure extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function handleOne(forge: Forge, message: Json): McpAnswer | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = 'id' in message ? message.id : null;
  const isNotification = !('id' in message) || method.startsWith('notifications/');
  try {
    switch (method) {
      case 'server/discover':
        return rpcResult(id, {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
          _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        });
      case 'initialize': {
        const params = isRecord(message.params) ? message.params : {};
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const revision = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : DEFAULT_REVISION;
        return rpcResult(id, { protocolVersion: revision, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const params = isRecord(message.params) ? message.params : {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args = isRecord(params.arguments) ? params.arguments : {};
        return rpcResult(id, callTool(forge, name, args));
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof RpcFailure) return rpcError(id, err.code, err.message);
    throw err;
  }
}

/**
 * Handle one POST /mcp body. A non-JSON body is the protocol's parse error: HTTP 400 with
 * a JSON-RPC -32700 body whose id is null. Notifications answer 202 with no body.
 */
export function handleMcp(forge: Forge, rawBody: string): McpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.filter(isRecord).map((message) => handleOne(forge, message)).filter((a): a is McpAnswer => a !== null);
    if (answers.length === 0) return { status: 202 };
    return { status: 200, body: answers.map((a) => a.body) };
  }
  if (!isRecord(parsed)) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } } };
  const answer = handleOne(forge, parsed);
  if (answer === null) return { status: 202 };
  return answer;
}
