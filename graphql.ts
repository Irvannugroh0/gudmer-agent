// graphql.ts — the GraphQL v4 surface (POST /api/graphql): a small lexer, parser,
// validator and executor for the document shapes `gh` and github-mcp-server send —
// viewer, repository reads, issue/pull-request connections with cursor pagination,
// __type introspection, node(id:), and the createIssue / closeIssue / createPullRequest /
// mergePullRequest / addComment mutations. Everything resolves against the same store
// as REST, so objects agree across surfaces. Global ids are opaque (base64 payloads),
// stable, and decode back for node(id:) and the mutation inputs.
//
// Protocol discipline: an unknown field is a validation error — HTTP 200 with an
// `errors` array naming the field — never an HTTP error. A batched body (a JSON array
// of operations) answers an array of results in order. An unknown repository reads
// data.repository = null with no errors.

import type { Forge, RepoRec, IssueRec, PullRec } from './store.ts';
import { mergeFileMaps } from './store.ts';

// ------------------------------------------------------------------ global ids

function gid(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64');
}

export function repoGid(repo: RepoRec): string {
  return gid(`Repository:${repo.id}`);
}

function issueGid(repo: RepoRec, number: number): string {
  return gid(`Issue:${repo.id}:${number}`);
}

function pullGid(repo: RepoRec, number: number): string {
  return gid(`PullRequest:${repo.id}:${number}`);
}

function commentGid(repo: RepoRec, issueNumber: number, commentId: number): string {
  return gid(`IssueComment:${repo.id}:${issueNumber}:${commentId}`);
}

function findRepoById(forge: Forge, id: number): RepoRec | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

function decodeGid(id: string): { kind: string; parts: number[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...rest] = text.split(':');
    if (kind === undefined || kind === '') return null;
    return { kind, parts: rest.map((part) => Number.parseInt(part, 10)) };
  } catch {
    return null;
  }
}

function ownerLogin(forge: Forge, repo: RepoRec): string {
  return repo.owner !== '' ? repo.owner : (forge.viewerLogin ?? 'viewer');
}

// ------------------------------------------------------------------ schema tables

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'target'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'createdAt',
    'updatedAt', 'closedAt', 'repository', 'url',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'author', 'createdAt', 'updatedAt', 'repository',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields'],
  __Field: ['name', 'description', 'type', 'isDeprecated'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** The object type a field's selection set applies to (absent = scalar leaf). */
const FIELD_TYPE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Issue: { author: 'User', repository: 'Repository' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest' },
  PullRequest: { files: 'PullRequestFileConnection', author: 'User', repository: 'Repository' },
  PullRequestFileConnection: { nodes: 'PullRequestChangedFile' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'IssueComment' },
  IssueComment: { author: 'User' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', at)) {
      tokens.push({ kind: 'spread' });
      at += 3;
      continue;
    }
    if ('{}()[]:$=!@|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(at + 3, end) });
        at = end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      if (at >= source.length) throw new Error('unterminated string');
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at));
      if (match === null) throw new Error(`bad number at ${at}`);
      const text = match[0];
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      at += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at));
      const text = (match as RegExpExecArray)[0];
      tokens.push({ kind: 'name', value: text });
      at += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${at}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: Map<string, Value>; selectionSet: Selection[] | null }
  | { kind: 'inline'; typeCondition: string; selectionSet: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selectionSet: Selection[] }>;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.at] as Token;
  }

  private next(): Token {
    return this.tokens[this.at++] as Token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw new Error(`expected ${value}`);
    this.at += 1;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: Selection[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation');
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.isPunct('(')) this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.isPunct('=')) {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.isPunct(':')) {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args = this.isPunct('(') ? this.parseArguments() : new Map<string, Value>();
      this.skipDirectives();
      const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expectPunct('}');
    return selections;
  }
}

// ------------------------------------------------------------------ values

type Json = Record<string, unknown>;

function evalValue(value: Value, variables: Json): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Json = {};
      for (const [key, inner] of value.fields) out[key] = evalValue(inner, variables);
      return out;
    }
  }
}

function evalArgs(args: Map<string, Value>, variables: Json): Json {
  const out: Json = {};
  for (const [key, value] of args) out[key] = evalValue(value, variables);
  return out;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

// ------------------------------------------------------------------ validation

function validateSet(typeName: string, selections: readonly Selection[], doc: Document, errors: string[]): void {
  const known = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      validateSet(selection.typeCondition, selection.selectionSet, doc, errors);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) errors.push(`Unknown fragment '${selection.name}'`);
      else validateSet(fragment.typeCondition, fragment.selectionSet, doc, errors);
      continue;
    }
    if (selection.name === '__typename') continue;
    if (known === undefined || !known.includes(selection.name)) {
      errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
      continue;
    }
    if (selection.selectionSet !== null) {
      const childType = FIELD_TYPE[typeName]?.[selection.name];
      if (childType !== undefined) validateSet(childType, selection.selectionSet, doc, errors);
    }
  }
}

// ------------------------------------------------------------------ execution

/** A resolved value tagged with the GraphQL type it executes as. */
interface Wrapped {
  __gql: string;
  [key: string]: unknown;
}

function wrap(type: string, fields: Json = {}): Wrapped {
  return { __gql: type, ...fields };
}

class GqlFailure extends Error {}

interface Ctx {
  forge: Forge;
  doc: Document;
  variables: Json;
}

function userWrap(login: string): Wrapped {
  return wrap('User', { login });
}

function repoWrap(repo: RepoRec): Wrapped {
  return wrap('Repository', { repo });
}

function issueWrap(repo: RepoRec, issue: IssueRec): Wrapped {
  return wrap('Issue', { repo, issue });
}

function pullWrap(repo: RepoRec, pull: PullRec): Wrapped {
  return wrap('PullRequest', { repo, pull });
}

function typeInfo(name: string): Wrapped | null {
  if (TYPE_FIELDS[name] !== undefined) return wrap('__Type', { name, kind: 'OBJECT' });
  if (ENUM_VALUES[name] !== undefined) return wrap('__Type', { name, kind: 'ENUM' });
  return null;
}

function decodeNode(forge: Forge, id: string): Wrapped | null {
  const decoded = decodeGid(id);
  if (decoded === null) return null;
  const [first, second] = decoded.parts;
  if (decoded.kind === 'Repository' && first !== undefined) {
    const repo = findRepoById(forge, first);
    return repo === null ? null : repoWrap(repo);
  }
  if (decoded.kind === 'Issue' && first !== undefined && second !== undefined) {
    const repo = findRepoById(forge, first);
    const issue = repo?.issues.get(second);
    return repo !== null && repo !== undefined && issue !== undefined ? issueWrap(repo, issue) : null;
  }
  if (decoded.kind === 'PullRequest' && first !== undefined && second !== undefined) {
    const repo = findRepoById(forge, first);
    const pull = repo?.pulls.get(second);
    return repo !== null && repo !== undefined && pull !== undefined ? pullWrap(repo, pull) : null;
  }
  return null;
}

// -------------------------------------------------------------- domain helpers

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

function issuesConnection(ctx: Ctx, repo: RepoRec, args: Json): Wrapped {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((entry) => str(entry).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? null) as Json | null;
  const field = orderBy !== null ? str(orderBy.field) : 'CREATED_AT';
  const direction = orderBy !== null ? str(orderBy.direction) : 'ASC';
  const keyOf = (issue: IssueRec): number => (field === 'COMMENTS' ? issue.comments.length : issue.createdSeq);
  list.sort((a, b) => (direction === 'DESC' ? keyOf(b) - keyOf(a) : keyOf(a) - keyOf(b)));
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const afterNumber = numberFromCursor(args.after);
    const index = afterNumber === null ? -1 : list.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const first = num(args.first);
  const page = first === null ? list.slice(start) : list.slice(start, start + Math.max(0, first));
  const hasNextPage = start + page.length < list.length;
  const last = page[page.length - 1];
  return wrap('IssueConnection', {
    nodes: page.map((issue) => issueWrap(repo, issue)),
    pageInfo: wrap('PageInfo', {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorOf((page[0] as IssueRec).number) : null,
      endCursor: last !== undefined ? cursorOf(last.number) : null,
    }),
    totalCount: list.length,
  });
}

function pullRequestsConnection(repo: RepoRec, args: Json): Wrapped {
  const list = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
  const first = num(args.first);
  const page = first === null ? list : list.slice(0, Math.max(0, first));
  return wrap('PullRequestConnection', {
    nodes: page.map((pull) => pullWrap(repo, pull)),
    totalCount: list.length,
  });
}

function pullFiles(ctx: Ctx, repo: RepoRec, pull: PullRec, args: Json): Wrapped {
  const forge = ctx.forge;
  const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseTip = forge.branchTip(repo, pull.baseRef) ?? headTip;
  const mb = forge.objects.mergeBase(baseTip, headTip) ?? baseTip;
  const before = forge.filesAt(mb);
  const after = forge.filesAt(headTip);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed = [...paths].filter((path) => before.get(path)?.sha !== after.get(path)?.sha).sort();
  const first = num(args.first);
  const page = first === null ? changed : changed.slice(0, Math.max(0, first));
  return wrap('PullRequestFileConnection', {
    nodes: page.map((path) => wrap('PullRequestChangedFile', { path, additions: 0, deletions: 0, changeType: 'MODIFIED' })),
    totalCount: changed.length,
  });
}

function pullMergeable(ctx: Ctx, repo: RepoRec, pull: PullRec): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const forge = ctx.forge;
  const baseTip = forge.branchTip(repo, pull.baseRef);
  const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  if (baseTip === undefined) return 'UNKNOWN';
  const mb = forge.objects.mergeBase(baseTip, headTip);
  if (mb === null || mb === headTip) return 'UNKNOWN';
  const merged = mergeFileMaps(forge.filesAt(mb), forge.filesAt(baseTip), forge.filesAt(headTip));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Perform a merge exactly as the REST surface does; returns the merge commit sha. */
function performMerge(ctx: Ctx, repo: RepoRec, pull: PullRec, method: string): string {
  const forge = ctx.forge;
  const baseTip = forge.branchTip(repo, pull.baseRef);
  const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  if (baseTip === undefined) throw new GqlFailure('Base branch not found');
  const mb = forge.objects.mergeBase(baseTip, headTip);
  if (mb === null || mb === headTip) throw new GqlFailure('Pull request is not mergeable: nothing to merge');
  const merged = mergeFileMaps(forge.filesAt(mb), forge.filesAt(baseTip), forge.filesAt(headTip));
  if (merged === null) throw new GqlFailure('Pull request is not mergeable: merge conflict');
  const tree = forge.objects.treeFromFiles(merged);
  const login = forge.viewerLogin ?? 'forge';
  const isSquash = method === 'SQUASH';
  const commitSha = forge.objects.commit({
    tree,
    parents: isSquash ? [baseTip] : [baseTip, headTip],
    message: isSquash ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}`,
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
  return commitSha;
}

// -------------------------------------------------------------- resolvers

type Resolver = (ctx: Ctx, source: Wrapped, args: Json) => unknown;

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: (ctx) => userWrap(ctx.forge.viewerLogin ?? 'viewer'),
    repository: (ctx, _source, args) => {
      const repo = ctx.forge.resolve(str(args.owner), str(args.name));
      return repo === undefined ? null : repoWrap(repo);
    },
    node: (ctx, _source, args) => decodeNode(ctx.forge, str(args.id)),
    __type: (_ctx, _source, args) => typeInfo(str(args.name)),
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGid(str(input.repositoryId));
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(ctx.forge, decoded.parts[0] ?? -1) : null;
      if (repo === null) throw new GqlFailure('Repository not found for repositoryId');
      const now = ctx.forge.nowIso();
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title: str(input.title),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: ctx.forge.nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(issue.number, issue);
      return wrap('CreateIssuePayload', { issue: issueWrap(repo, issue), clientMutationId: null });
    },
    closeIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGid(str(input.issueId));
      if (decoded === null || decoded.kind !== 'Issue') throw new GqlFailure('Issue not found for issueId');
      const repo = findRepoById(ctx.forge, decoded.parts[0] ?? -1);
      const issue = repo?.issues.get(decoded.parts[1] ?? -1);
      if (repo === null || repo === undefined || issue === undefined) throw new GqlFailure('Issue not found for issueId');
      issue.state = 'closed';
      issue.updatedAt = ctx.forge.nowIso();
      return wrap('CloseIssuePayload', { issue: issueWrap(repo, issue), clientMutationId: null });
    },
    createPullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGid(str(input.repositoryId));
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(ctx.forge, decoded.parts[0] ?? -1) : null;
      if (repo === null) throw new GqlFailure('Repository not found for repositoryId');
      const stripPrefix = (ref: string): string => {
        const colon = ref.indexOf(':');
        return colon === -1 ? ref : ref.slice(colon + 1);
      };
      const head = stripPrefix(str(input.headRefName));
      const base = stripPrefix(str(input.baseRefName)) || repo.defaultBranch;
      const headSha = ctx.forge.branchTip(repo, head);
      if (headSha === undefined) throw new GqlFailure(`Head branch not found: ${head}`);
      if (ctx.forge.branchTip(repo, base) === undefined) throw new GqlFailure(`Base branch not found: ${base}`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          throw new GqlFailure('A pull request already exists for this branch combination');
        }
      }
      const now = ctx.forge.nowIso();
      const pull: PullRec = {
        number: repo.nextNumber++,
        title: str(input.title),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headShaAtCreate: headSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: ctx.forge.nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.set(pull.number, pull);
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrap(repo, pull), clientMutationId: null });
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGid(str(input.pullRequestId));
      if (decoded === null || decoded.kind !== 'PullRequest') throw new GqlFailure('Pull request not found for pullRequestId');
      const repo = findRepoById(ctx.forge, decoded.parts[0] ?? -1);
      const pull = repo?.pulls.get(decoded.parts[1] ?? -1);
      if (repo === null || repo === undefined || pull === undefined) throw new GqlFailure('Pull request not found for pullRequestId');
      if (!pull.merged) {
        if (pull.state !== 'open') throw new GqlFailure('Pull request is not open');
        performMerge(ctx, repo, pull, str(input.mergeMethod) || 'MERGE');
      }
      return wrap('MergePullRequestPayload', { pullRequest: pullWrap(repo, pull), clientMutationId: null });
    },
    addComment: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGid(str(input.subjectId));
      if (decoded === null || decoded.kind !== 'Issue') throw new GqlFailure('Subject not found for subjectId');
      const repo = findRepoById(ctx.forge, decoded.parts[0] ?? -1);
      const issue = repo?.issues.get(decoded.parts[1] ?? -1);
      if (repo === null || repo === undefined || issue === undefined) throw new GqlFailure('Subject not found for subjectId');
      const comment = { id: repo.nextCommentId++, body: str(input.body), createdAt: ctx.forge.nowIso() };
      issue.comments.push(comment);
      issue.updatedAt = ctx.forge.nowIso();
      const node = wrap('IssueComment', { id: commentGid(repo, issue.number, comment.id), body: comment.body, createdAt: comment.createdAt });
      return wrap('AddCommentPayload', { commentEdge: wrap('CommentEdge', { node, cursor: cursorOf(issue.number) }), clientMutationId: null });
    },
  },
  User: {
    id: () => gid('User:1'),
    login: (_ctx, source) => source.login,
    name: (_ctx, source) => source.login,
  },
  Repository: {
    id: (_ctx, source) => repoGid(source.repo as RepoRec),
    databaseId: (_ctx, source) => (source.repo as RepoRec).id,
    name: (_ctx, source) => (source.repo as RepoRec).name,
    nameWithOwner: (ctx, source) => {
      const repo = source.repo as RepoRec;
      return `${ownerLogin(ctx.forge, repo)}/${repo.name}`;
    },
    owner: (ctx, source) => userWrap(ownerLogin(ctx.forge, source.repo as RepoRec)),
    defaultBranchRef: (_ctx, source) => wrap('Ref', { name: (source.repo as RepoRec).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_ctx, source) => (source.repo as RepoRec).description,
    isPrivate: (_ctx, source) => (source.repo as RepoRec).private,
    createdAt: (_ctx, source) => (source.repo as RepoRec).createdAt,
    updatedAt: (_ctx, source) => (source.repo as RepoRec).createdAt,
    issue: (_ctx, source, args) => {
      const repo = source.repo as RepoRec;
      const number = num(args.number);
      const issue = number === null ? undefined : repo.issues.get(number);
      return issue === undefined ? null : issueWrap(repo, issue);
    },
    issues: (ctx, source, args) => issuesConnection(ctx, source.repo as RepoRec, args),
    pullRequest: (_ctx, source, args) => {
      const repo = source.repo as RepoRec;
      const number = num(args.number);
      const pull = number === null ? undefined : repo.pulls.get(number);
      return pull === undefined ? null : pullWrap(repo, pull);
    },
    pullRequests: (_ctx, source, args) => pullRequestsConnection(source.repo as RepoRec, args),
  },
  Ref: {
    name: (_ctx, source) => source.name,
    target: () => null,
  },
  Issue: {
    id: (_ctx, source) => issueGid(source.repo as RepoRec, (source.issue as IssueRec).number),
    number: (_ctx, source) => (source.issue as IssueRec).number,
    title: (_ctx, source) => (source.issue as IssueRec).title,
    state: (_ctx, source) => (source.issue as IssueRec).state.toUpperCase(),
    body: (_ctx, source) => (source.issue as IssueRec).body,
    author: (ctx) => userWrap(ctx.forge.viewerLogin ?? 'viewer'),
    comments: () => wrap('IssueConnection', { nodes: [], totalCount: 0 }),
    labels: () => null,
    createdAt: (_ctx, source) => (source.issue as IssueRec).createdAt,
    updatedAt: (_ctx, source) => (source.issue as IssueRec).updatedAt,
    closedAt: (_ctx, source) => ((source.issue as IssueRec).state === 'closed' ? (source.issue as IssueRec).updatedAt : null),
    repository: (_ctx, source) => repoWrap(source.repo as RepoRec),
    url: () => null,
  },
  IssueConnection: {
    nodes: (_ctx, source) => source.nodes,
    edges: () => null,
    pageInfo: (_ctx, source) => source.pageInfo,
    totalCount: (_ctx, source) => source.totalCount,
  },
  PageInfo: {
    hasNextPage: (_ctx, source) => source.hasNextPage,
    hasPreviousPage: (_ctx, source) => source.hasPreviousPage,
    startCursor: (_ctx, source) => source.startCursor,
    endCursor: (_ctx, source) => source.endCursor,
  },
  PullRequest: {
    id: (_ctx, source) => pullGid(source.repo as RepoRec, (source.pull as PullRec).number),
    number: (_ctx, source) => (source.pull as PullRec).number,
    title: (_ctx, source) => (source.pull as PullRec).title,
    body: (_ctx, source) => (source.pull as PullRec).body,
    state: (_ctx, source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (_ctx, source) => (source.pull as PullRec).merged,
    headRefName: (_ctx, source) => (source.pull as PullRec).headRef,
    baseRefName: (_ctx, source) => (source.pull as PullRec).baseRef,
    mergeable: (ctx, source) => pullMergeable(ctx, source.repo as RepoRec, source.pull as PullRec),
    files: (ctx, source, args) => pullFiles(ctx, source.repo as RepoRec, source.pull as PullRec, args),
    author: (ctx) => userWrap(ctx.forge.viewerLogin ?? 'viewer'),
    createdAt: (_ctx, source) => (source.pull as PullRec).createdAt,
    updatedAt: (_ctx, source) => (source.pull as PullRec).updatedAt,
    repository: (_ctx, source) => repoWrap(source.repo as RepoRec),
  },
  PullRequestConnection: {
    nodes: (_ctx, source) => source.nodes,
    edges: () => null,
    pageInfo: () => null,
    totalCount: (_ctx, source) => source.totalCount,
  },
  PullRequestFileConnection: {
    nodes: (_ctx, source) => source.nodes,
    edges: () => null,
    pageInfo: () => null,
    totalCount: (_ctx, source) => source.totalCount,
  },
  PullRequestChangedFile: {
    path: (_ctx, source) => source.path,
    additions: (_ctx, source) => source.additions,
    deletions: (_ctx, source) => source.deletions,
    changeType: (_ctx, source) => source.changeType,
  },
  IssueComment: {
    id: (_ctx, source) => source.id,
    body: (_ctx, source) => source.body,
    author: (ctx) => userWrap(ctx.forge.viewerLogin ?? 'viewer'),
    createdAt: (_ctx, source) => source.createdAt,
  },
  CreateIssuePayload: {
    issue: (_ctx, source) => source.issue,
    clientMutationId: (_ctx, source) => source.clientMutationId,
  },
  CloseIssuePayload: {
    issue: (_ctx, source) => source.issue,
    clientMutationId: (_ctx, source) => source.clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, source) => source.pullRequest,
    clientMutationId: (_ctx, source) => source.clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, source) => source.pullRequest,
    clientMutationId: (_ctx, source) => source.clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, source) => source.commentEdge,
    clientMutationId: (_ctx, source) => source.clientMutationId,
  },
  CommentEdge: {
    node: (_ctx, source) => source.node,
    cursor: (_ctx, source) => source.cursor,
  },
  Node: {
    id: (ctx, source) => {
      if (source.__gql === 'Repository') return repoGid(source.repo as RepoRec);
      if (source.__gql === 'Issue') return issueGid(source.repo as RepoRec, (source.issue as IssueRec).number);
      if (source.__gql === 'PullRequest') return pullGid(source.repo as RepoRec, (source.pull as PullRec).number);
      return gid('Node:0');
    },
  },
  __Type: {
    name: (_ctx, source) => source.name,
    kind: (_ctx, source) => source.kind,
    description: () => null,
    fields: (_ctx, source) => {
      const fields = TYPE_FIELDS[str(source.name)];
      return fields === undefined ? null : fields.map((name) => wrap('__Field', { name }));
    },
    enumValues: (_ctx, source) => {
      const values = ENUM_VALUES[str(source.name)];
      return values === undefined ? null : values.map((name) => wrap('__EnumValue', { name }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
  },
  __Field: {
    name: (_ctx, source) => source.name,
    description: () => null,
    type: () => null,
    isDeprecated: () => false,
  },
  __EnumValue: {
    name: (_ctx, source) => source.name,
    description: () => null,
    isDeprecated: () => false,
  },
  __Schema: {
    types: () => [],
    queryType: () => typeInfo('Query'),
    mutationType: () => typeInfo('Mutation'),
  },
};

// -------------------------------------------------------------- executor

function isWrapped(value: unknown): value is Wrapped {
  return typeof value === 'object' && value !== null && '__gql' in (value as Json);
}

function executeSet(ctx: Ctx, typeName: string, source: Wrapped, selections: readonly Selection[]): Json {
  const out: Json = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (source.__gql === selection.typeCondition || typeName === selection.typeCondition) {
        Object.assign(out, executeSet(ctx, selection.typeCondition, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment !== undefined && (source.__gql === fragment.typeCondition || typeName === fragment.typeCondition)) {
        Object.assign(out, executeSet(ctx, fragment.typeCondition, source, fragment.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source.__gql;
      continue;
    }
    // Node is an interface: fields other than id execute against the concrete type.
    const effectiveType = typeName === 'Node' ? source.__gql : typeName;
    const resolver = RESOLVERS[effectiveType]?.[selection.name] ?? RESOLVERS[typeName]?.[selection.name];
    if (resolver === undefined) {
      out[key] = null;
      continue;
    }
    const args = evalArgs(selection.args, ctx.variables);
    const value = resolver(ctx, source, args);
    out[key] = completeValue(ctx, FIELD_TYPE[effectiveType]?.[selection.name] ?? FIELD_TYPE[typeName]?.[selection.name], value, selection.selectionSet);
  }
  return out;
}

function completeValue(ctx: Ctx, typeName: string | undefined, value: unknown, selectionSet: Selection[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (selectionSet === null || selectionSet.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => (isWrapped(entry) ? executeSet(ctx, typeName ?? entry.__gql, entry, selectionSet) : entry));
  }
  if (isWrapped(value)) return executeSet(ctx, typeName ?? value.__gql, value, selectionSet);
  return value;
}

function executeOperation(ctx: Ctx, operation: Operation): { data: Json } | { data: null; errors: Array<{ message: string }> } {
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSet(rootType, operation.selectionSet, ctx.doc, errors);
  if (errors.length > 0) return { data: null, errors: errors.map((message) => ({ message })) };
  try {
    const data = executeSet(ctx, rootType, wrap(rootType), operation.selectionSet);
    return { data };
  } catch (err) {
    if (err instanceof GqlFailure) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

// -------------------------------------------------------------- HTTP entry

export interface GraphqlAnswer {
  status: number;
  body: unknown;
}

function executeOne(forge: Forge, request: Json): GraphqlAnswer {
  const query = request.query;
  if (typeof query !== 'string' || query === '') {
    return { status: 400, body: { errors: [{ message: 'A GraphQL request needs a query string' }] } };
  }
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Json;
  let doc: Document;
  try {
    doc = new Parser(query).parseDocument();
  } catch (err) {
    return { status: 200, body: { errors: [{ message: `Syntax error: ${err instanceof Error ? err.message : String(err)}` }] } };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = operationName !== null
    ? doc.operations.find((op) => op.name === operationName) ?? doc.operations[0]
    : doc.operations[0];
  if (operation === undefined) return { status: 200, body: { errors: [{ message: 'No operation in the document' }] } };
  const ctx: Ctx = { forge, doc, variables };
  const result = executeOperation(ctx, operation);
  return { status: 200, body: result };
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphql(forge: Forge, rawBody: string): GraphqlAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => {
      const answer = executeOne(forge, (typeof entry === 'object' && entry !== null ? entry : {}) as Json);
      return answer.body;
    });
    return { status: 200, body: answers };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { errors: [{ message: 'Request body must be an operation object' }] } };
  }
  return executeOne(forge, parsed as Json);
}
