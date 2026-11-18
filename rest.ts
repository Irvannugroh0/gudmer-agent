// rest.ts — the GitHub REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, all over the store in store.ts. The endpoint contract
// (statuses, shapes) is the one checks-rest.ts in the kit states; shapes allow extra fields,
// so serializers answer with GitHub-flavoured objects and the checks pick what they need.

import {
  diffLineCounts,
  mergeFileMaps,
  type Forge,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
  type Sha,
} from './store.ts';

export interface ApiReq {
  readonly method: string;
  /** Decoded path segments after /api/v3. */
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  /** The parsed JSON body (undefined when absent or not an object/array). */
  readonly body: Record<string, unknown> | undefined;
  /** The request's Host header, for absolute Link URLs. */
  readonly host: string;
}

export interface ApiRes {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

type Json = Record<string, unknown>;

const notFound = (): ApiRes => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): ApiRes => ({ status: 422, body: { message } });

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ------------------------------------------------------------------ serializers

function ownerJson(forge: Forge, repo: RepoRec): Json {
  return { login: repo.owner !== '' ? repo.owner : (forge.viewerLogin ?? 'viewer'), id: 1, type: 'User' };
}

export function repoJson(forge: Forge, repo: RepoRec): Json {
  const owner = ownerJson(forge, repo);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${String(owner.login)}/${repo.name}`,
    private: repo.private,
    owner,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/api/v3/repos/${String(owner.login)}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length +
      [...repo.pulls.values()].filter((pull) => pull.state === 'open').length,
  };
}

function labelJson(label: LabelRec, repo: RepoRec): Json {
  return { id: repo.id * 1000 + label.name.length, node_id: `LA_${label.name}`, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec): Json {
  return {
    id: repo.id * 100_000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name } : labelJson(label, repo);
    }),
    user: ownerJson(forge, repo),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Json {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? headSha;
  return {
    id: repo.id * 100_000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { label: `${String(ownerJson(forge, repo).login)}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${String(ownerJson(forge, repo).login)}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: ownerJson(forge, repo),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commitJson(forge: Forge, sha: Sha): Json | null {
  const commit = forge.objects.readCommit(sha);
  if (commit === null) return null;
  const when = forge.commitIso(commit.timeSec);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: { name: commit.authorName, email: commit.authorEmail, date: when },
      committer: { name: commit.authorName, email: commit.authorEmail, date: when },
      message: commit.message,
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------ pagination

interface Page<T> {
  readonly items: T[];
  readonly link: string | null;
}

function paginate<T>(items: readonly T[], req: ApiReq, path: string): Page<T> {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(req.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const url = (p: number): string => `http://${req.host}${path}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${url(page + 1)}>; rel="next"`, `<${url(totalPages)}>; rel="last"`);
  if (page > 1) parts.push(`<${url(page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  return { items: slice, link: parts.length > 0 ? parts.join(', ') : null };
}

function withLink<T>(res: ApiRes, page: Page<T>): ApiRes {
  return page.link === null ? res : { ...res, headers: { ...(res.headers ?? {}), link: page.link } };
}

// ------------------------------------------------------------------ repo routing

/** Resolve (and, on first sight, adopt the login for) a /repos/{owner}/{name} route. */
function routeRepo(forge: Forge, owner: string, name: string): RepoRec | undefined {
  const repo = forge.resolve(owner, name);
  if (repo !== undefined && forge.viewerLogin === null && repo.owner !== owner) forge.adoptLogin(owner);
  return repo;
}

export function handleRest(forge: Forge, req: ApiReq): ApiRes {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0', github_hostname: 'forge.local' } };
  }

  if (seg[0] === 'rate_limit' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { resources: { core: { limit: 5000, remaining: 5000, reset: 1893456000 } }, rate: { limit: 5000, remaining: 5000, reset: 1893456000 } } };
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    const login = forge.viewerLogin ?? 'viewer';
    return { status: 200, body: { login, id: 1, type: 'User', name: login } };
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const page = paginate(all, req, '/api/v3/user/repos');
      return withLink({ status: 200, body: page.items.map((repo) => repoJson(forge, repo)) }, page);
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const name = str(body.name);
      if (name === '') return unprocessable('Validation Failed: name is required');
      const created = forge.createRepo(name, boolOr(body.private, false), typeof body.description === 'string' ? body.description : null);
      if (created === 'duplicate') return unprocessable('Validation Failed: name already exists on this account');
      return { status: 201, body: repoJson(forge, created) };
    }
    return notFound();
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const repo = routeRepo(forge, owner, name);
    if (repo === undefined) return notFound();
    return handleRepo(forge, req, repo, seg.slice(3));
  }

  return notFound();
}

function handleRepo(forge: Forge, req: ApiReq, repo: RepoRec, seg: readonly string[]): ApiRes {
  const method = req.method;

  if (seg.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(forge, repo) };
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body.description === 'string' || body.description === null) repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      return { status: 200, body: repoJson(forge, repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204 };
    }
    return notFound();
  }

  if (seg[0] === 'branches') {
    if (seg.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      return { status: 200, body: branches };
    }
    if (seg.length >= 2 && method === 'GET') {
      const branch = seg.slice(1).join('/');
      const sha = forge.branchTip(repo, branch);
      if (sha === undefined) return notFound();
      return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
    }
    return notFound();
  }

  if (seg[0] === 'commits' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    const ref = req.query.get('sha');
    let tip: Sha | undefined;
    if (ref === null || ref === '') tip = forge.branchTip(repo, repo.defaultBranch);
    else tip = forge.branchTip(repo, ref) ?? (forge.objects.has(ref) ? ref : undefined);
    if (tip === undefined) return { status: 200, body: [] };
    const all = forge.objects.ancestry(tip).map((sha) => commitJson(forge, sha)).filter((entry) => entry !== null);
    const page = paginate(all, req, '');
    return { status: 200, body: page.items };
  }

  if (seg[0] === 'git' && seg[1] === 'refs') return handleRefs(forge, req, repo, seg.slice(2));
  if (seg[0] === 'contents') return handleContents(forge, req, repo, seg.slice(1).join('/'));
  if (seg[0] === 'labels') return handleLabels(forge, req, repo, seg.slice(1));
  if (seg[0] === 'issues') return handleIssues(forge, req, repo, seg.slice(1));
  if (seg[0] === 'pulls') return handlePulls(forge, req, repo, seg.slice(1));

  return notFound();
}

// ------------------------------------------------------------------ git refs (REST)

function handleRefs(forge: Forge, req: ApiReq, repo: RepoRec, seg: readonly string[]): ApiRes {
  const method = req.method;
  if (seg.length === 0) {
    if (method === 'POST') {
      const body = req.body ?? {};
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !forge.objects.has(sha)) return unprocessable('Validation Failed: ref or sha is invalid');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } } };
    }
    if (method === 'GET') {
      const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } }));
      return { status: 200, body: all };
    }
    return notFound();
  }
  const ref = `refs/${seg.join('/')}`;
  if (method === 'GET') {
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound();
    return { status: 200, body: { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } } };
  }
  if (method === 'DELETE') {
    if (!repo.refs.delete(ref)) return notFound();
    return { status: 204 };
  }
  return notFound();
}

// ------------------------------------------------------------------ contents

function resolveCommit(forge: Forge, repo: RepoRec, ref: string | null): Sha | undefined {
  if (ref === null || ref === '') return forge.branchTip(repo, repo.defaultBranch);
  return forge.branchTip(repo, ref) ?? (forge.objects.has(ref) && forge.objects.readCommit(ref) !== null ? ref : undefined);
}

function handleContents(forge: Forge, req: ApiReq, repo: RepoRec, path: string): ApiRes {
  const method = req.method;

  if (method === 'GET') {
    const commitSha = resolveCommit(forge, repo, req.query.get('ref'));
    if (commitSha === undefined) return notFound();
    const commit = forge.objects.readCommit(commitSha);
    if (commit === null) return notFound();
    const files = forge.objects.flattenTree(commit.tree);
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean !== '' && files.has(clean)) {
      const entry = files.get(clean) as { sha: Sha; mode: string };
      const data = forge.objects.blobData(entry.sha);
      if (data === undefined) return notFound();
      const name = clean.split('/').pop() as string;
      return {
        status: 200,
        body: { type: 'file', encoding: 'base64', content: data.toString('base64'), sha: entry.sha, size: data.length, name, path: clean },
      };
    }
    // Directory listing (root when clean === '').
    const prefix = clean === '' ? '' : `${clean}/`;
    const children = new Map<string, { type: 'file' | 'dir'; sha: Sha; size?: number }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        children.set(rest, { type: 'file', sha: entry.sha, size: forge.objects.blobData(entry.sha)?.length ?? 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) {
          const dirPath = `${prefix}${dir}`;
          const sub = forge.objects.subtreeSha(commit.tree, dirPath);
          if (sub !== null) children.set(dir, { type: 'dir', sha: sub });
        }
      }
    }
    if (clean !== '' && children.size === 0) return notFound();
    const listing = [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, entry]) => ({ type: entry.type, name, path: `${prefix}${name}`, sha: entry.sha, ...(entry.size !== undefined ? { size: entry.size } : {}) }));
    return { status: 200, body: listing };
  }

  if (method === 'PUT') {
    const body = req.body ?? {};
    const message = str(body.message) || 'Update file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = forge.branchTip(repo, branch);
    if (tip === undefined && repo.refs.size > 0) return notFound();
    const contentB64 = str(body.content).replace(/[\r\n\t ]+/g, '');
    const bytes = Buffer.from(contentB64, 'base64');
    const files = forge.filesAt(tip);
    const existing = files.get(path);
    if (existing !== undefined) {
      if (typeof body.sha !== 'string') return unprocessable('Validation Failed: sha is required to update a file');
      if (body.sha !== existing.sha) return { status: 409, body: { message: 'Conflict: the file sha does not match' } };
    } else if (typeof body.sha === 'string') {
      return notFound();
    }
    const blobSha = forge.objects.blob(bytes);
    const commitSha = forge.commitFiles(repo, branch, message, (map) => {
      map.set(path, { sha: blobSha, mode: '100644' });
    });
    return {
      status: existing !== undefined ? 200 : 201,
      body: {
        content: { type: 'file', encoding: 'base64', sha: blobSha, size: bytes.length, name: path.split('/').pop() ?? path, path },
        commit: { sha: commitSha, message },
      },
    };
  }

  if (method === 'DELETE') {
    const body = req.body ?? {};
    const message = str(body.message) || 'Delete file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = forge.branchTip(repo, branch);
    if (tip === undefined) return notFound();
    const files = forge.filesAt(tip);
    const existing = files.get(path);
    if (existing === undefined) return notFound();
    if (typeof body.sha === 'string' && body.sha !== existing.sha) return { status: 409, body: { message: 'Conflict: the file sha does not match' } };
    const commitSha = forge.commitFiles(repo, branch, message, (map) => {
      map.delete(path);
    });
    return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
  }

  return notFound();
}

// ------------------------------------------------------------------ labels

function handleLabels(forge: Forge, req: ApiReq, repo: RepoRec, seg: readonly string[]): ApiRes {
  const method = req.method;
  if (seg.length === 0) {
    if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map((label) => labelJson(label, repo)) };
    if (method === 'POST') {
      const body = req.body ?? {};
      const name = str(body.name);
      if (name === '') return unprocessable('Validation Failed: name is required');
      if (repo.labels.has(name)) return unprocessable('Validation Failed: a label with that name already exists');
      const label: LabelRec = { name, color: str(body.color) || 'ededed', description: typeof body.description === 'string' ? body.description : null };
      repo.labels.set(name, label);
      return { status: 201, body: labelJson(label, repo) };
    }
    return notFound();
  }
  const label = repo.labels.get(seg.join('/'));
  if (label === undefined) return notFound();
  if (method === 'GET') return { status: 200, body: labelJson(label, repo) };
  if (method === 'DELETE') {
    repo.labels.delete(label.name);
    return { status: 204 };
  }
  return notFound();
}

// ------------------------------------------------------------------ issues

function handleIssues(forge: Forge, req: ApiReq, repo: RepoRec, seg: readonly string[]): ApiRes {
  const method = req.method;
  if (seg.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const page = paginate(list, req, '');
      return { status: 200, body: page.items.map((issue) => issueJson(forge, repo, issue)) };
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const title = str(body.title);
      if (title === '') return unprocessable('Validation Failed: title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.map((entry) => (typeof entry === 'string' ? entry : str((entry as Json)?.name))) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label ${JSON.stringify(name)} does not exist`);
      }
      const now = forge.nowIso();
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: labelNames,
        comments: [],
        createdSeq: forge.nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(issue.number, issue);
      return { status: 201, body: issueJson(forge, repo, issue) };
    }
    return notFound();
  }

  const number = Number(seg[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound();
  const issue = repo.issues.get(number);

  if (seg.length === 1) {
    if (issue === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(forge, repo, issue) };
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const names = body.labels.map((entry) => (typeof entry === 'string' ? entry : str((entry as Json)?.name)));
        for (const name of names) if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label ${JSON.stringify(name)} does not exist`);
        issue.labels = names;
      }
      issue.updatedAt = forge.nowIso();
      return { status: 200, body: issueJson(forge, repo, issue) };
    }
    return notFound();
  }

  if (seg[1] === 'comments' && seg.length === 2) {
    if (issue === undefined) return notFound();
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(forge, repo, comment)) };
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const comment = { id: repo.nextCommentId++, body: str(body.body), createdAt: forge.nowIso() };
      issue.comments.push(comment);
      return { status: 201, body: commentJson(forge, repo, comment) };
    }
    return notFound();
  }

  if (seg[1] === 'labels' && seg.length === 2 && method === 'POST') {
    if (issue === undefined) return notFound();
    const body = req.body ?? {};
    const names = Array.isArray(body.labels) ? body.labels.map((entry) => str(entry)) : [];
    for (const name of names) if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label ${JSON.stringify(name)} does not exist`);
    for (const name of names) if (!issue.labels.includes(name)) issue.labels.push(name);
    return { status: 200, body: issue.labels.map((name) => labelJson(repo.labels.get(name) as LabelRec, repo)) };
  }

  return notFound();
}

function commentJson(forge: Forge, repo: RepoRec, comment: { id: number; body: string; createdAt: string }): Json {
  return { id: comment.id, body: comment.body, user: ownerJson(forge, repo), created_at: comment.createdAt, updated_at: comment.createdAt };
}

// ------------------------------------------------------------------ pulls

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

function handlePulls(forge: Forge, req: ApiReq, repo: RepoRec, seg: readonly string[]): ApiRes {
  const method = req.method;
  if (seg.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const page = paginate(list, req, '');
      return { status: 200, body: page.items.map((pull) => pullJson(forge, repo, pull)) };
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const head = stripOwnerPrefix(str(body.head));
      const base = stripOwnerPrefix(str(body.base)) || repo.defaultBranch;
      const headSha = forge.branchTip(repo, head);
      if (headSha === undefined) return unprocessable(`Validation Failed: head branch ${JSON.stringify(head)} does not exist`);
      if (forge.branchTip(repo, base) === undefined) return unprocessable(`Validation Failed: base branch ${JSON.stringify(base)} does not exist`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) return unprocessable('Validation Failed: a pull request already exists for this branch combination');
      }
      const now = forge.nowIso();
      const pull: PullRec = {
        number: repo.nextNumber++,
        title: str(body.title),
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headShaAtCreate: headSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: forge.nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.set(pull.number, pull);
      return { status: 201, body: pullJson(forge, repo, pull) };
    }
    return notFound();
  }

  const number = Number(seg[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound();
  const pull = repo.pulls.get(number);

  if (seg.length === 1) {
    if (pull === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: pullJson(forge, repo, pull) };
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      pull.updatedAt = forge.nowIso();
      return { status: 200, body: pullJson(forge, repo, pull) };
    }
    return notFound();
  }

  if (pull === undefined) return notFound();

  if (seg[1] === 'files' && seg.length === 2 && method === 'GET') {
    const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
    const baseTip = forge.branchTip(repo, pull.baseRef) ?? headTip;
    const mb = forge.objects.mergeBase(baseTip, headTip) ?? baseTip;
    const before = forge.filesAt(mb);
    const after = forge.filesAt(headTip);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const files: Json[] = [];
    for (const path of [...paths].sort()) {
      const b = before.get(path);
      const a = after.get(path);
      if (b?.sha === a?.sha) continue;
      const beforeText = b === undefined ? '' : (forge.objects.blobData(b.sha)?.toString('utf8') ?? '');
      const afterText = a === undefined ? '' : (forge.objects.blobData(a.sha)?.toString('utf8') ?? '');
      const counts = diffLineCounts(beforeText, afterText);
      files.push({
        filename: path,
        status: b === undefined ? 'added' : a === undefined ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        sha: (a ?? b)?.sha ?? '',
      });
    }
    const page = paginate(files, req, '');
    return { status: 200, body: page.items };
  }

  if (seg[1] === 'merge' && seg.length === 2 && method === 'PUT') {
    if (pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not mergeable: it is not open' } };
    const baseTip = forge.branchTip(repo, pull.baseRef);
    const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
    if (baseTip === undefined) return notFound();
    const mb = forge.objects.mergeBase(baseTip, headTip);
    if (mb === null || mb === headTip) return { status: 405, body: { message: 'Pull Request is not mergeable: nothing to merge' } };
    const merged = mergeFileMaps(forge.filesAt(mb), forge.filesAt(baseTip), forge.filesAt(headTip));
    if (merged === null) return { status: 405, body: { message: 'Pull Request is not mergeable: merge conflict' } };
    const body = req.body ?? {};
    const methodWanted = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const tree = forge.objects.treeFromFiles(merged);
    const login = forge.viewerLogin ?? 'forge';
    const isSquash = methodWanted === 'squash';
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
    return { status: 200, body: { sha: commitSha, merged: true, message: 'Pull Request successfully merged' } };
  }

  return notFound();
}
