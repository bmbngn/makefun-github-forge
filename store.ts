// In-memory store for the forge: repos, git objects, issues, pulls, labels, comments.
// All state lives here; HTTP/GraphQL/MCP are thin views over it.
import {
  ZERO_OID, hashObject, buildTree, buildCommit, parseCommit, parseTree, parseTag,
  collectReachable, type GitObject, type GitObjectType, type TreeEntry,
} from './git.ts';

export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}
export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

export interface Issue {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

export interface Pull {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  globalId: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string; description: string }>;
  issues: Issue[];
  pulls: Pull[];
  comments: Map<number, Comment[]>;
  seq: number; // shared issue+PR number sequence (GitHub numbers issues and PRs together)
  commentSeq: number;
  createdSeq: number;
}

let repoIdSeq = 1;
let objectIdSeq = 1;
let nowCounter = 0;

export function nowIso(): string {
  // Monotonic-ish ISO timestamps: real time, nudged so rapid creates keep order.
  const t = Date.now() + nowCounter++;
  return new Date(t).toISOString();
}
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class Store {
  repos = new Map<string, Repo>();
  reposById = new Map<number, Repo>();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): { repo?: Repo; error?: string } {
    const k = this.key(owner, name);
    if (this.repos.has(k)) return { error: 'already exists' };
    const id = repoIdSeq++;
    const repo: Repo = {
      id,
      globalId: globalId('Repository', String(id)),
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      comments: new Map(),
      seq: 0,
      commentSeq: 0,
      createdSeq: 0,
    };
    this.repos.set(k, repo);
    this.reposById.set(id, repo);
    return { repo };
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  viewerRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq || a.id - b.id);
    return out;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Resolve a ref-ish to a commit oid: 'main', 'refs/heads/main', or a 40-hex sha. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const oid = ref.toLowerCase();
      const obj = repo.objects.get(oid);
      return obj && obj.type === 'commit' ? oid : null;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  refTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const author = `${VIEWER.name} <${VIEWER.email}>`;
    const data = buildCommit({ tree: treeOid, parents, message: message.endsWith('\n') ? message : `${message}\n`, author, committer: author, timestamp: nowSec() });
    return this.putObject(repo, 'commit', data);
  }

  commitTree(repo: Repo, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  commitMessage(repo: Repo, commitOid: string): string {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return '';
    const text = obj.data.toString('utf8');
    const idx = text.indexOf('\n\n');
    return idx >= 0 ? text.slice(idx + 2).replace(/\n$/, '') : '';
  }

  /** Walk a tree by path segments; returns the entry or null. */
  treeEntryAt(repo: Repo, treeOid: string, segments: readonly string[]): TreeEntry | null {
    let current = treeOid;
    for (let i = 0; i < segments.length; i++) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return null;
      const entries = parseTree(obj.data);
      const hit = entries.find((e) => e.name === segments[i]);
      if (!hit) return null;
      if (i === segments.length - 1) return hit;
      if (hit.mode !== '40000') return null;
      current = hit.oid;
    }
    return null;
  }

  /** Set (or delete, when blobOid is null) a path in a tree; returns the new root tree oid. */
  setPathInTree(repo: Repo, baseTreeOid: string | null, segments: readonly string[], blobOid: string | null): string {
    if (segments.length === 0) return baseTreeOid ?? this.putObject(repo, 'tree', buildTree([]));
    const [head, ...rest] = segments as [string, ...string[]];
    const baseEntries: TreeEntry[] = baseTreeOid ? parseTree(repo.objects.get(baseTreeOid)?.data ?? Buffer.alloc(0)) : [];
    const existing = baseEntries.find((e) => e.name === head);
    let next: TreeEntry[] = baseEntries.filter((e) => e.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) next.push({ mode: '100644', name: head, oid: blobOid });
      // else: delete — already filtered out
    } else {
      const childTree = existing && existing.mode === '40000' ? existing.oid : null;
      const newChild = this.setPathInTree(repo, childTree, rest, blobOid);
      const childObj = repo.objects.get(newChild);
      const empty = childObj && childObj.type === 'tree' && parseTree(childObj.data).length === 0;
      if (!empty) next.push({ mode: '40000', name: head, oid: newChild });
    }
    return this.putObject(repo, 'tree', buildTree(next));
  }

  /** Flat map of path -> {oid, mode} for a tree (recursive). */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') this.flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
    return out;
  }

  /** Diff base tree -> head tree. */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const base = baseTreeOid ? this.flattenTree(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
    const head = headTreeOid ? this.flattenTree(repo, headTreeOid) : new Map<string, { oid: string; mode: string }>();
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    for (const [path, h] of head) {
      const b = base.get(path);
      if (!b) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    for (const [path, b] of base) {
      if (!head.has(path)) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** Is `ancestor` reachable from `oid` (parent walk)? */
  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      stack.push(...parseCommit(obj.data).parents);
    }
    return false;
  }

  /** History of a branch tip, newest first. */
  history(repo: Repo, tip: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length && out.length < limit) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      out.push(cur);
      stack.push(...parseCommit(obj.data).parents);
    }
    return out;
  }

  // ------------------------------------------------------------ contents

  readPath(repo: Repo, ref: string, path: string): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return null;
    const tree = this.commitTree(repo, tip);
    if (!tree) return null;
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) {
      return { kind: 'dir', entries: parseTree(repo.objects.get(tree)?.data ?? Buffer.alloc(0)) };
    }
    const entry = this.treeEntryAt(repo, tree, segments);
    if (!entry) return null;
    if (entry.mode === '40000') {
      return { kind: 'dir', entries: parseTree(repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0)) };
    }
    const blob = repo.objects.get(entry.oid);
    if (!blob) return null;
    return { kind: 'file', oid: entry.oid, data: blob.data };
  }

  writeFile(repo: Repo, branch: string, path: string, content: Buffer, message: string, expectedSha?: string): { commitSha: string; blobSha: string } | { error: string; status: number } {
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName) ?? null;
    if (tip === null && repo.refs.size > 0 && branch !== repo.defaultBranch) {
      // Auto-create the branch from the default tip (contents-write fallback).
      const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (base) {
        repo.refs.set(refName, base);
        tip = base;
      }
    }
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return { error: 'invalid path', status: 422 };
    if (expectedSha !== undefined && tip !== null) {
      const tree = this.commitTree(repo, tip);
      const cur = tree ? this.treeEntryAt(repo, tree, segments) : null;
      if (!cur || cur.oid.toLowerCase() !== expectedSha.toLowerCase()) {
        return { error: 'sha does not match the current file', status: 409 };
      }
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const baseTree = tip ? this.commitTree(repo, tip) : null;
    const newTree = this.setPathInTree(repo, baseTree, segments, blobSha);
    const commitSha = this.makeCommit(repo, newTree, tip ? [tip] : [], message);
    repo.refs.set(refName, commitSha);
    repo.updatedAt = nowIso();
    return { commitSha, blobSha };
  }

  deleteFile(repo: Repo, branch: string, path: string, message: string, expectedSha?: string): { commitSha: string } | { error: string; status: number } {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    if (!tip) return { error: 'not found', status: 404 };
    const segments = path.split('/').filter((s) => s.length > 0);
    const tree = this.commitTree(repo, tip);
    const cur = tree ? this.treeEntryAt(repo, tree, segments) : null;
    if (!cur) return { error: 'not found', status: 404 };
    if (expectedSha !== undefined && cur.oid.toLowerCase() !== expectedSha.toLowerCase()) {
      return { error: 'sha does not match the current file', status: 409 };
    }
    const newTree = this.setPathInTree(repo, tree, segments, null);
    const commitSha = this.makeCommit(repo, newTree, [tip], message);
    repo.refs.set(refName, commitSha);
    repo.updatedAt = nowIso();
    return { commitSha };
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = ++repo.seq;
    const issue: Issue = {
      number,
      id: objectIdSeq++,
      globalId: globalId('Issue', `${repo.id}:${number}`),
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      user: VIEWER.login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
      seq: repo.seq,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const comment: Comment = {
      id: ++repo.commentSeq,
      globalId: globalId('IssueComment', `${repo.id}:${issueNumber}:${repo.commentSeq}`),
      body,
      user: VIEWER.login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // ------------------------------------------------------------ pulls

  createPull(repo: Repo, title: string, body: string, head: string, base: string): { pull?: Pull; error?: string } {
    const headSha = this.refTip(repo, head);
    const baseSha = this.refTip(repo, base);
    if (!headSha || !baseSha) return { error: 'head or base branch not found' };
    const number = ++repo.seq;
    const pull: Pull = {
      number,
      id: objectIdSeq++,
      globalId: globalId('PullRequest', `${repo.id}:${number}`),
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      user: VIEWER.login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      seq: repo.seq,
    };
    repo.pulls.push(pull);
    return { pull };
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTree = this.commitTree(repo, pull.headSha);
    const baseTree = this.commitTree(repo, pull.baseSha);
    const diff = this.diffTrees(repo, baseTree, headTree);
    return diff.map((d) => {
      const newData = d.newOid ? repo.objects.get(d.newOid)?.data : null;
      const oldData = d.oldOid ? repo.objects.get(d.oldOid)?.data : null;
      const countLines = (b: Buffer | null | undefined): number => {
        if (!b || b.length === 0) return 0;
        return b.toString('utf8').split('\n').length - (b[b.length - 1] === 0x0a ? 1 : 0);
      };
      let additions = 0, deletions = 0;
      if (d.status === 'added') additions = Math.max(1, countLines(newData));
      else if (d.status === 'removed') deletions = Math.max(1, countLines(oldData));
      else { additions = countLines(newData); deletions = countLines(oldData); if (additions === 0 && deletions === 0) additions = 1; }
      return { filename: d.path, status: d.status === 'added' ? 'added' : d.status === 'removed' ? 'removed' : 'modified', additions, deletions, changes: additions + deletions };
    });
  }

  /** Three-way mergeability of a PR against the current base tip. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    if (pull.state !== 'open') return 'CONFLICTING';
    const tipSha = this.refTip(repo, pull.base);
    if (!tipSha) return 'CONFLICTING';
    if (tipSha === pull.baseSha) return 'MERGEABLE';
    const baseTree = this.commitTree(repo, pull.baseSha);
    const headTree = this.commitTree(repo, pull.headSha);
    const tipTree = this.commitTree(repo, tipSha);
    const diff = this.diffTrees(repo, baseTree, headTree);
    const tipFlat = tipTree ? this.flattenTree(repo, tipTree) : new Map();
    const baseFlat = baseTree ? this.flattenTree(repo, baseTree) : new Map();
    for (const d of diff) {
      const baseEntry = baseFlat.get(d.path);
      const tipEntry = tipFlat.get(d.path);
      const baseOid = baseEntry?.oid ?? null;
      const tipOid = tipEntry?.oid ?? null;
      if (tipOid === baseOid) continue; // untouched on base: clean
      if (tipOid === d.newOid) continue; // already the same change: clean
      return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'pull request is already closed', status: 405 };
    if (this.pullMergeable(repo, pull) === 'CONFLICTING') {
      return { error: 'merge conflict', status: 405 };
    }
    const tipSha = this.refTip(repo, pull.base);
    if (!tipSha) return { error: 'base branch not found', status: 422 };
    const baseTree = this.commitTree(repo, pull.baseSha);
    const headTree = this.commitTree(repo, pull.headSha);
    const tipTree = this.commitTree(repo, tipSha);
    const diff = this.diffTrees(repo, baseTree, headTree);
    let tree = tipTree;
    for (const d of diff) {
      const segments = d.path.split('/').filter((s) => s.length > 0);
      tree = this.setPathInTree(repo, tree, segments, d.newOid);
    }
    const message = `Merge pull request #${pull.number} from ${pull.head}`;
    const sha = this.makeCommit(repo, tree ?? this.putObject(repo, 'tree', buildTree([])), [tipSha], message);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = nowIso();
    repo.updatedAt = nowIso();
    return { sha };
  }
}

export function reachableObjects(repo: Repo, tips: Iterable<string>): Set<string> {
  return collectReachable(tips, (oid) => repo.objects.get(oid));
}

export { ZERO_OID };
export type { GitObject };
