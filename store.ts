// store.ts — the forge's heart: a real git object store (blob/tree/commit with genuine SHA-1
// ids, so the REST contents API and the git smart-HTTP server share one truth) plus the
// in-memory domain store (repositories, labels, issues, pull requests).
//
// Everything lives in Maps in this process: a trial is one process against a fresh store.
// Commit timestamps come from a store clock that starts at a fixed epoch and advances one
// minute per commit, so ids are stable within a run and ancestry order never depends on the
// wall clock.

import { createHash } from 'node:crypto';

export type Sha = string;

export interface GitObject {
  readonly type: 'blob' | 'tree' | 'commit' | 'tag';
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly name: string;
  readonly mode: string; // '100644' | '100755' | '120000' | '40000' | '160000'
  readonly sha: Sha;
}

export interface CommitData {
  readonly tree: Sha;
  readonly parents: readonly Sha[];
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly timeSec: number;
}

export function sha1Hex(data: Buffer): Sha {
  return createHash('sha1').update(data).digest('hex');
}

export class ObjectStore {
  readonly objects = new Map<Sha, GitObject>();
  /**
   * Parsed-commit memo. Stored objects are immutable (put is idempotent and the
   * bytes behind an id never change), so a parse stays valid for the store's life.
   * Ancestry walks and fetch planning re-read the same commits constantly; parsing
   * (utf8 decode + line split + regex) dominated their cost.
   */
  private readonly commitParseCache = new Map<Sha, CommitData | null>();

  /** Hash and store one object; returns its id. Idempotent. */
  put(type: GitObject['type'], data: Buffer): Sha {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const sha = createHash('sha1').update(header).update(data).digest('hex');
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  get(sha: Sha): GitObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: Sha): boolean {
    return this.objects.has(sha);
  }

  blob(data: Buffer): Sha {
    return this.put('blob', data);
  }

  blobData(sha: Sha): Buffer | undefined {
    const object = this.objects.get(sha);
    return object !== undefined && object.type === 'blob' ? object.data : undefined;
  }

  /** Serialize tree entries (git order: by name, directories as name+'/') into a tree object. */
  tree(entries: readonly TreeEntry[]): Sha {
    const sorted = [...entries].sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of sorted) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.sha, 'hex'));
    }
    return this.put('tree', Buffer.concat(parts));
  }

  /** Parse a tree object back into entries. */
  readTree(sha: Sha): TreeEntry[] {
    const object = this.objects.get(sha);
    if (object === undefined || object.type !== 'tree') return [];
    const entries: TreeEntry[] = [];
    let at = 0;
    while (at < object.data.length) {
      const space = object.data.indexOf(0x20, at);
      const mode = object.data.toString('utf8', at, space);
      const nul = object.data.indexOf(0x00, space + 1);
      const name = object.data.toString('utf8', space + 1, nul);
      const entrySha = object.data.toString('hex', nul + 1, nul + 21);
      entries.push({ name, mode, sha: entrySha });
      at = nul + 21;
    }
    return entries;
  }

  /**
   * Build (recursively) the tree for a flat path -> {sha, mode} file map and return its id.
   * The map is the working representation every surface edits; trees are derived from it.
   */
  treeFromFiles(files: ReadonlyMap<string, FileEntry>): Sha {
    interface Node {
      files: Map<string, FileEntry>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let next = node.dirs.get(part);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1] as string, entry);
    }
    const build = (node: Node): Sha => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ name, mode: entry.mode, sha: entry.sha });
      for (const [name, dir] of node.dirs) entries.push({ name, mode: '40000', sha: build(dir) });
      return this.tree(entries);
    };
    return build(root);
  }

  /** Flatten a tree (recursively) into path -> {sha, mode}; only blob entries are listed. */
  flattenTree(treeSha: Sha, prefix = ''): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    const walk = (sha: Sha, at: string): void => {
      for (const entry of this.readTree(sha)) {
        const path = at === '' ? entry.name : `${at}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.sha, path);
        else out.set(path, { sha: entry.sha, mode: entry.mode });
      }
    };
    walk(treeSha, prefix);
    return out;
  }

  /** The tree id of the subtree at `prefix` inside `treeSha`, or null when absent. */
  subtreeSha(treeSha: Sha, prefix: string): Sha | null {
    if (prefix === '') return treeSha;
    let current = treeSha;
    for (const part of prefix.split('/')) {
      const entry = this.readTree(current).find((candidate) => candidate.name === part && candidate.mode === '40000');
      if (entry === undefined) return null;
      current = entry.sha;
    }
    return current;
  }

  commit(data: CommitData): Sha {
    const lines: string[] = [`tree ${data.tree}`];
    for (const parent of data.parents) lines.push(`parent ${parent}`);
    const identity = `${data.authorName} <${data.authorEmail}> ${data.timeSec} +0000`;
    lines.push(`author ${identity}`);
    lines.push(`committer ${identity}`);
    const payload = Buffer.from(`${lines.join('\n')}\n\n${data.message}`, 'utf8');
    return this.put('commit', payload);
  }

  readCommit(sha: Sha): CommitData | null {
    const cached = this.commitParseCache.get(sha);
    if (cached !== undefined) return cached;
    const parsed = this.parseCommit(sha);
    this.commitParseCache.set(sha, parsed);
    return parsed;
  }

  private parseCommit(sha: Sha): CommitData | null {
    const object = this.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return null;
    const text = object.data.toString('utf8');
    const split = text.indexOf('\n\n');
    const header = split === -1 ? text : text.slice(0, split);
    const message = split === -1 ? '' : text.slice(split + 2);
    let tree = '';
    const parents: Sha[] = [];
    let authorName = '';
    let authorEmail = '';
    let timeSec = 0;
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) {
        const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.slice(7));
        if (match !== null) {
          authorName = match[1] as string;
          authorEmail = match[2] as string;
          timeSec = Number(match[3]);
        }
      }
    }
    return { tree, parents, message, authorName, authorEmail, timeSec };
  }

  /** Every commit reachable from `tip`, newest first (breadth by generation). */
  ancestry(tip: Sha): Sha[] {
    const seen = new Set<Sha>();
    const order: Sha[] = [];
    let frontier: Sha[] = [tip];
    while (frontier.length > 0) {
      const next: Sha[] = [];
      for (const sha of frontier) {
        if (seen.has(sha)) continue;
        seen.add(sha);
        order.push(sha);
        const commit = this.readCommit(sha);
        if (commit !== null) next.push(...commit.parents);
      }
      frontier = next;
    }
    return order;
  }

  /** The first common ancestor of two commits (BFS from both), or null. */
  mergeBase(a: Sha, b: Sha): Sha | null {
    const fromA = new Set(this.ancestry(a));
    for (const sha of this.ancestry(b)) if (fromA.has(sha)) return sha;
    return null;
  }

  /**
   * True when `ancestor` is reachable from `tip` (tip itself included). Unlike
   * ancestry(), the walk stops the moment the ancestor is found: a fast-forward
   * check on a linear branch finds its answer at the first parent, instead of
   * materialising the branch's whole history on every push.
   */
  isAncestor(ancestor: Sha, tip: Sha): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<Sha>();
    const stack: Sha[] = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as Sha;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.readCommit(sha);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }
}

export interface FileEntry {
  readonly sha: Sha;
  readonly mode: string;
}

export interface CommentRec {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface IssueRec {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  headShaAtCreate: Sha;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: Sha | null;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface LabelRec {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

export interface RepoRec {
  readonly id: number;
  owner: string; // '' until the viewer's login is learned from a request path
  readonly name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  readonly refs: Map<string, Sha>; // full ref ('refs/heads/main') -> commit sha
  readonly labels: Map<string, LabelRec>;
  readonly issues: Map<number, IssueRec>;
  readonly pulls: Map<number, PullRec>;
  nextNumber: number;
  nextCommentId: number;
  readonly createdSeq: number;
  readonly createdAt: string;
}

/** The whole forge: one object store, every repository, and the learned viewer login. */
export class Forge {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, RepoRec>();
  viewerLogin: string | null = null;
  private seq = 0;
  private repoId = 0;
  private clockSec = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario epoch

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A commit timestamp: fixed epoch plus one minute per commit, so ids never collide. */
  nextCommitTime(): number {
    this.clockSec += 60;
    return this.clockSec;
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  commitIso(timeSec: number): string {
    return new Date(timeSec * 1000).toISOString();
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Learn the token owner's login from a request path and re-key pending repositories. */
  adoptLogin(login: string): void {
    if (login === '' || this.viewerLogin !== null) return;
    this.viewerLogin = login;
    for (const repo of this.repos.values()) {
      if (repo.owner === '') repo.owner = login;
    }
    const rebuilt = new Map<string, RepoRec>();
    for (const repo of this.repos.values()) rebuilt.set(this.key(repo.owner, repo.name), repo);
    this.repos.clear();
    for (const [key, repo] of rebuilt) this.repos.set(key, repo);
  }

  findByName(name: string): RepoRec | undefined {
    for (const repo of this.repos.values()) if (repo.name === name) return repo;
    return undefined;
  }

  /**
   * Resolve a repository for a `/repos/{owner}/{name}` or git path. When the viewer login is
   * not yet known, a unique name match resolves (and the caller adopts the login). A known
   * foreign owner never resolves the viewer's repositories.
   */
  resolve(owner: string, name: string): RepoRec | undefined {
    const exact = this.repos.get(this.key(owner, name));
    if (exact !== undefined) return exact;
    if (this.viewerLogin === null) return this.findByName(name);
    if (owner === this.viewerLogin) return this.repos.get(this.key('', name));
    return undefined;
  }

  createRepo(name: string, priv: boolean, description: string | null): RepoRec | 'duplicate' {
    if (this.findByName(name) !== undefined) return 'duplicate';
    this.repoId += 1;
    const repo: RepoRec = {
      id: this.repoId,
      owner: this.viewerLogin ?? '',
      name,
      private: priv,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdSeq: this.nextSeq(),
      createdAt: this.nowIso(),
    };
    this.repos.set(this.key(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  /** The branch tip commit, or undefined when the branch does not exist. */
  branchTip(repo: RepoRec, branch: string): Sha | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The flat file map at a commit (empty map for an unborn branch). */
  filesAt(commitSha: Sha | undefined): Map<string, FileEntry> {
    if (commitSha === undefined) return new Map();
    const commit = this.objects.readCommit(commitSha);
    if (commit === null) return new Map();
    return this.objects.flattenTree(commit.tree);
  }

  /**
   * Commit a mutation of a branch's file map. Returns the new commit sha, or null when the
   * mutation produced no change.
   */
  commitFiles(repo: RepoRec, branch: string, message: string, mutate: (files: Map<string, FileEntry>) => void): Sha {
    const parent = this.branchTip(repo, branch);
    const files = this.filesAt(parent);
    mutate(files);
    const tree = this.objects.treeFromFiles(files);
    const login = this.viewerLogin ?? 'forge';
    const sha = this.objects.commit({
      tree,
      parents: parent === undefined ? [] : [parent],
      message,
      authorName: login,
      authorEmail: `${login}@example.invalid`,
      timeSec: this.nextCommitTime(),
    });
    repo.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }
}

/** Line counts of a text diff (LCS length over lines), for pull-request file stats. */
export function diffLineCounts(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // LCS length with two rolling rows.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

/**
 * Three-way tree merge over flat file maps. Returns the merged map, or null on a conflict
 * (both sides changed the same path to different blobs, or one deleted what the other changed).
 */
export function mergeFileMaps(
  base: ReadonlyMap<string, FileEntry>,
  ours: ReadonlyMap<string, FileEntry>,
  theirs: ReadonlyMap<string, FileEntry>,
): Map<string, FileEntry> | null {
  const out = new Map<string, FileEntry>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOT = o?.sha === t?.sha && o?.mode === t?.mode;
    if (sameOT) {
      if (o !== undefined) out.set(path, o);
      continue;
    }
    const oursChanged = o?.sha !== b?.sha || o?.mode !== b?.mode;
    const theirsChanged = t?.sha !== b?.sha || t?.mode !== b?.mode;
    if (oursChanged && theirsChanged) return null;
    if (theirsChanged) {
      if (t !== undefined) out.set(path, t);
    } else if (o !== undefined) {
      out.set(path, o);
    }
  }
  return out;
}
