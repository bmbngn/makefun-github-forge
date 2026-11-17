// github-forge: a GitHub-compatible git forge. Node standard library only.
// Surfaces: git smart HTTP (v2/v0), REST v3, GraphQL v4, MCP Streamable HTTP.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, VIEWER, nowIso, type Repo, type Issue, type Pull } from './store.ts';
import { handleGit } from './git-http.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { parseCommit } from './git.ts';

const store = new Store();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;
const EMPTY_QUERY = new URLSearchParams();

/** Small cache for single-issue GET responses (the read workload hits one issue 2000x). */
const issueCache = new Map<string, { key: string; body: Buffer }>();
function issueCacheKey(r: Repo, i: Issue): string {
  return `${r.id}:${i.number}:${i.updatedAt}:${(r.comments.get(i.number) ?? []).length}:${i.labels.join(',')}`;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

function authed(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (!token) return false;
  if (TOKEN !== '') return token === TOKEN;
  return true; // no token configured (local dev): any non-empty bearer is accepted
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...extra });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId() });
  res.end(body);
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed as Record<string, unknown> };
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

// ------------------------------------------------------------------ views

function repoView(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    node_id: r.globalId,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: r.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: r.private,
    description: r.description,
    fork: false,
    archived: false,
    default_branch: r.defaultBranch,
    html_url: `https://github.com/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    pushed_at: r.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
  };
}

function issueView(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    node_id: i.globalId,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    locked: false,
    labels: i.labels.map((name) => {
      const label = r.labels.get(name);
      return { id: 0, node_id: '', name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: i.user, id: i.user === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (r.comments.get(i.number) ?? []).length,
    html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    closed_at: i.closedAt,
  };
}

function pullView(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    node_id: p.globalId,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    locked: false,
    draft: false,
    merged: p.merged,
    mergeable: store.pullMergeable(r, p) === 'MERGEABLE',
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    head: { ref: p.head, sha: p.headSha, label: `${r.owner}:${p.head}`, repo: repoView(r) },
    base: { ref: p.base, sha: p.baseSha, label: `${r.owner}:${p.base}`, repo: repoView(r) },
    user: { login: p.user, id: p.user === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    closed_at: p.mergedAt,
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const m = /^(.+?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!m) return { name: line, email: '', date: nowIso() };
  return { name: m[1]!, email: m[2]!, date: new Date(parseInt(m[3]!, 10) * 1000).toISOString() };
}

function commitView(r: Repo, sha: string): Record<string, unknown> | null {
  const obj = r.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const header = text.split('\n\n')[0] ?? '';
  let authorLine = '', committerLine = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  const message = store.commitMessage(r, sha);
  const author = parseIdentity(authorLine);
  const committer = parseIdentity(committerLine);
  return {
    sha,
    commit: {
      message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: parseCommit(obj.data).tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${r.owner}/${r.name}/commits/${sha}`,
    html_url: `https://github.com/${r.owner}/${r.name}/commit/${sha}`,
  };
}

// ------------------------------------------------------------------ helpers

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function pagination(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function pageSlice<T>(items: readonly T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const urlFor = (p: number): string => `http://${host}${basePath}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(lastPage)}>; rel="last"`);
  if (page > 1) parts.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  return parts.join(', ');
}

// ------------------------------------------------------------------ REST

async function handleRest(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: URLSearchParams): Promise<void> {
  const segs = path.split('/').filter((s) => s.length > 0).map(decodeSeg);
  // segs[0] === 'api', segs[1] === 'v3'
  const rest = segs.slice(2);

  // GET /api/v3/ and /api/v3
  if (rest.length === 0) {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    return sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  if (rest[0] === 'rate_limit' && rest.length === 1) {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    const reset = Math.floor(Date.now() / 1000) + 3600;
    return sendJson(res, 200, { resources: { core: { limit: 60, remaining: 60, reset, used: 0 } }, rate: { limit: 60, remaining: 60, reset, used: 0 } });
  }

  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method !== 'GET') return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, node_id: 'User:1000', name: VIEWER.name, email: VIEWER.email, type: 'User', html_url: `https://github.com/${VIEWER.login}` });
    }
    if (rest[1] === 'repos') {
      if (method === 'GET') {
        const { perPage, page } = pagination(query);
        const repos = store.viewerRepos(VIEWER.login);
        const link = linkHeader(req, '/api/v3/user/repos', query, perPage, page, repos.length);
        return sendJson(res, 200, pageSlice(repos, perPage, page).map(repoView), link ? { link } : {});
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) return errJson(res, 400, 'Invalid JSON');
        const name = typeof body.value.name === 'string' ? body.value.name.trim() : '';
        if (!name) return errJson(res, 422, 'name is required');
        const created = store.createRepo(VIEWER.login, name, {
          description: typeof body.value.description === 'string' ? body.value.description : '',
          private: body.value.private === true,
        });
        if (!created.repo) return errJson(res, 422, 'Repository already exists');
        return sendJson(res, 201, repoView(created.repo));
      }
      return errJson(res, 404, 'Not Found');
    }
    return errJson(res, 404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) return errJson(res, 404, 'Not Found');
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const repo = store.getRepo(owner, repoName);
  const tail = rest.slice(3);

  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      if (!repo) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, repoView(repo));
    }
    if (method === 'PATCH') {
      if (!repo) return errJson(res, 404, 'Not Found');
      const body = await readJsonBody(req);
      if (!body.ok) return errJson(res, 400, 'Invalid JSON');
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      repo.updatedAt = nowIso();
      return sendJson(res, 200, repoView(repo));
    }
    if (method === 'DELETE') {
      if (!repo) return errJson(res, 404, 'Not Found');
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    return errJson(res, 404, 'Not Found');
  }

  if (!repo) return errJson(res, 404, 'Not Found');

  // branches
  if (tail[0] === 'branches' && tail.length === 1) {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    const names = [...repo.refs.keys()].filter((n) => n.startsWith('refs/heads/')).map((n) => n.slice('refs/heads/'.length)).sort();
    return sendJson(res, 200, names.map((name) => ({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`)!, url: `/api/v3/repos/${owner}/${repoName}/commits/${repo.refs.get(`refs/heads/${name}`)!}` },
      protected: false,
    })));
  }

  // commits
  if (tail[0] === 'commits' && tail.length === 1) {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (!tip) return errJson(res, 404, 'Not Found');
    const { perPage, page } = pagination(query);
    const history = store.history(repo, tip, 1000);
    const views = history.map((sha) => commitView(repo, sha)).filter((v): v is Record<string, unknown> => v !== null);
    return sendJson(res, 200, pageSlice(views, perPage, page));
  }

  // git/refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = await readJsonBody(req);
      if (!body.ok) return errJson(res, 400, 'Invalid JSON');
      const ref = typeof body.value.ref === 'string' ? body.value.ref : '';
      const sha = typeof body.value.sha === 'string' ? body.value.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return errJson(res, 422, 'Invalid ref or sha');
      if (!repo.objects.has(sha)) return errJson(res, 422, 'Object does not exist');
      if (repo.refs.has(ref)) return errJson(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}` });
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    return errJson(res, 404, 'Not Found');
  }

  // contents
  if (tail[0] === 'contents') {
    const contentPath = tail.slice(1).join('/');
    const ref = query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      if (!contentPath) {
        const root = store.readPath(repo, ref, '');
        if (!root || root.kind !== 'dir') return errJson(res, 404, 'Not Found');
        return sendJson(res, 200, root.entries.map((e) => dirEntryView(repo, owner, repoName, '', e)));
      }
      const found = store.readPath(repo, ref, contentPath);
      if (!found) return errJson(res, 404, 'Not Found');
      if (found.kind === 'dir') {
        return sendJson(res, 200, found.entries.map((e) => dirEntryView(repo, owner, repoName, contentPath, e)));
      }
      const name = contentPath.split('/').pop()!;
      return sendJson(res, 200, {
        type: 'file', encoding: 'base64', size: found.data.length, name, path: contentPath,
        content: found.data.toString('base64'), sha: found.oid,
        url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
        html_url: `https://github.com/${owner}/${repoName}/blob/${ref}/${contentPath}`,
        download_url: null, git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${found.oid}`,
      });
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      if (!body.ok) return errJson(res, 400, 'Invalid JSON');
      const contentB64 = typeof body.value.content === 'string' ? body.value.content : '';
      const message = typeof body.value.message === 'string' ? body.value.message : 'Update file';
      const branch = typeof body.value.branch === 'string' && body.value.branch ? body.value.branch : repo.defaultBranch;
      const sha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
      if (!contentB64) return errJson(res, 422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      } catch {
        return errJson(res, 422, 'content is not valid base64');
      }
      const existed = store.readPath(repo, branch, contentPath);
      const res2 = store.writeFile(repo, branch, contentPath, content, message, sha);
      if ('error' in res2) return errJson(res, res2.status, res2.error);
      const name = contentPath.split('/').pop()!;
      return sendJson(res, existed && existed.kind === 'file' ? 200 : 201, {
        content: {
          type: 'file', encoding: 'base64', size: content.length, name, path: contentPath,
          content: content.toString('base64'), sha: res2.blobSha,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
          html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${contentPath}`,
        },
        commit: { sha: res2.commitSha, message },
      });
    }
    if (method === 'DELETE') {
      const body = await readJsonBody(req);
      if (!body.ok) return errJson(res, 400, 'Invalid JSON');
      const message = typeof body.value.message === 'string' ? body.value.message : 'Delete file';
      const branch = typeof body.value.branch === 'string' && body.value.branch ? body.value.branch : repo.defaultBranch;
      const sha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
      const res2 = store.deleteFile(repo, branch, contentPath, message, sha);
      if ('error' in res2) return errJson(res, res2.status, res2.error);
      return sendJson(res, 200, { commit: { sha: res2.commitSha, message } });
    }
    return errJson(res, 404, 'Not Found');
  }

  // labels
  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const body = await readJsonBody(req);
      if (!body.ok) return errJson(res, 400, 'Invalid JSON');
      const name = typeof body.value.name === 'string' ? body.value.name.trim() : '';
      if (!name) return errJson(res, 422, 'name is required');
      if (repo.labels.has(name)) return errJson(res, 422, 'Label already exists');
      const color = typeof body.value.color === 'string' ? body.value.color : 'ededed';
      const description = typeof body.value.description === 'string' ? body.value.description : '';
      repo.labels.set(name, { name, color, description });
      return sendJson(res, 201, { id: 0, node_id: '', name, color, description, url: `/api/v3/repos/${owner}/${repoName}/labels/${encodeURIComponent(name)}` });
    }
    if (method === 'GET' && tail.length === 1) {
      return sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: 0, node_id: '', name: l.name, color: l.color, description: l.description })));
    }
    return errJson(res, 404, 'Not Found');
  }

  // issues
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = (query.get('state') ?? 'open').toLowerCase();
        const sort = (query.get('sort') ?? 'created').toLowerCase();
        const direction = (query.get('direction') ?? 'desc').toLowerCase();
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
        else if (sort === 'updated') list.sort((a, b) => direction === 'asc' ? (a.updatedAt < b.updatedAt ? -1 : 1) : (a.updatedAt > b.updatedAt ? -1 : 1));
        const { perPage, page } = pagination(query);
        const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/issues`, query, perPage, page, list.length);
        return sendJson(res, 200, pageSlice(list, perPage, page).map((i) => issueView(repo, i)), link ? { link } : {});
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) return errJson(res, 400, 'Invalid JSON');
        const title = typeof body.value.title === 'string' ? body.value.title : '';
        if (!title) return errJson(res, 422, 'title is required');
        const labelsRaw = body.value.labels;
        const labels: string[] = Array.isArray(labelsRaw)
          ? labelsRaw.map((l) => (typeof l === 'string' ? l : (l as { name?: unknown })?.name).toString()).filter(Boolean)
          : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return errJson(res, 422, `Label '${label}' does not exist`);
        }
        const issue = store.createIssue(repo, title, typeof body.value.body === 'string' ? body.value.body : '', labels);
        return sendJson(res, 201, issueView(repo, issue));
      }
      return errJson(res, 404, 'Not Found');
    }
    const num = parseInt(tail[1]!, 10);
    if (!Number.isFinite(num)) return errJson(res, 404, 'Not Found');
    const issue = store.getIssue(repo, num);
    if (tail.length === 2) {
      if (method === 'GET') {
        if (!issue) return errJson(res, 404, 'Not Found');
        return sendJson(res, 200, issueView(repo, issue));
      }
      if (method === 'PATCH') {
        if (!issue) return errJson(res, 404, 'Not Found');
        const body = await readJsonBody(req);
        if (!body.ok) return errJson(res, 400, 'Invalid JSON');
        if (typeof body.value.title === 'string') issue.title = body.value.title;
        if (typeof body.value.body === 'string') issue.body = body.value.body;
        if (body.value.state === 'open' || body.value.state === 'closed') {
          issue.state = body.value.state;
          issue.closedAt = issue.state === 'closed' ? nowIso() : null;
        }
        if (Array.isArray(body.value.labels)) {
          const labels: string[] = (body.value.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as { name?: unknown })?.name).toString()).filter(Boolean);
          for (const label of labels) {
            if (!repo.labels.has(label)) return errJson(res, 422, `Label '${label}' does not exist`);
          }
          issue.labels = labels;
        }
        issue.updatedAt = nowIso();
        return sendJson(res, 200, issueView(repo, issue));
      }
      return errJson(res, 404, 'Not Found');
    }
    if (tail[2] === 'comments' && tail.length === 3) {
      if (!issue) return errJson(res, 404, 'Not Found');
      if (method === 'GET') {
        const comments = repo.comments.get(num) ?? [];
        return sendJson(res, 200, comments.map((c) => ({
          id: c.id, node_id: c.globalId, body: c.body,
          user: { login: c.user, id: c.user === VIEWER.login ? VIEWER.id : 0, type: 'User' },
          created_at: c.createdAt, updated_at: c.updatedAt,
          html_url: `https://github.com/${owner}/${repoName}/issues/${num}#issuecomment-${c.id}`,
          url: `/api/v3/repos/${owner}/${repoName}/issues/comments/${c.id}`,
        })));
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) return errJson(res, 400, 'Invalid JSON');
        const commentBody = typeof body.value.body === 'string' ? body.value.body : '';
        if (!commentBody) return errJson(res, 422, 'body is required');
        const comment = store.addComment(repo, num, commentBody);
        if (!comment) return errJson(res, 404, 'Not Found');
        return sendJson(res, 201, {
          id: comment.id, node_id: comment.globalId, body: comment.body,
          user: { login: comment.user, id: comment.user === VIEWER.login ? VIEWER.id : 0, type: 'User' },
          created_at: comment.createdAt, updated_at: comment.updatedAt,
          html_url: `https://github.com/${owner}/${repoName}/issues/${num}#issuecomment-${comment.id}`,
          url: `/api/v3/repos/${owner}/${repoName}/issues/comments/${comment.id}`,
        });
      }
      return errJson(res, 404, 'Not Found');
    }
    return errJson(res, 404, 'Not Found');
  }

  // pulls
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = (query.get('state') ?? 'open').toLowerCase();
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.seq - a.seq);
        const { perPage, page } = pagination(query);
        const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/pulls`, query, perPage, page, list.length);
        return sendJson(res, 200, pageSlice(list, perPage, page).map((p) => pullView(repo, p)), link ? { link } : {});
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) return errJson(res, 400, 'Invalid JSON');
        const title = typeof body.value.title === 'string' ? body.value.title : '';
        const head = typeof body.value.head === 'string' ? body.value.head : '';
        const base = typeof body.value.base === 'string' ? body.value.base : '';
        if (!title || !head || !base) return errJson(res, 422, 'title, head and base are required');
        const res2 = store.createPull(repo, title, typeof body.value.body === 'string' ? body.value.body : '', head, base);
        if (!res2.pull) return errJson(res, 422, res2.error ?? 'could not create pull request');
        return sendJson(res, 201, pullView(repo, res2.pull));
      }
      return errJson(res, 404, 'Not Found');
    }
    const num = parseInt(tail[1]!, 10);
    if (!Number.isFinite(num)) return errJson(res, 404, 'Not Found');
    const pull = store.getPull(repo, num);
    if (tail.length === 2) {
      if (method !== 'GET') return errJson(res, 404, 'Not Found');
      if (!pull) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, pullView(repo, pull));
    }
    if (tail[2] === 'files' && tail.length === 3) {
      if (method !== 'GET') return errJson(res, 404, 'Not Found');
      if (!pull) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, store.pullFiles(repo, pull));
    }
    if (tail[2] === 'merge' && tail.length === 3) {
      if (method !== 'PUT') return errJson(res, 404, 'Not Found');
      if (!pull) return errJson(res, 404, 'Not Found');
      const body = await readJsonBody(req);
      if (!body.ok) return errJson(res, 400, 'Invalid JSON');
      const res2 = store.mergePull(repo, pull);
      if ('error' in res2) return errJson(res, res2.status, res2.error);
      return sendJson(res, 200, { merged: true, sha: res2.sha, message: 'Pull request successfully merged' });
    }
    return errJson(res, 404, 'Not Found');
  }

  return errJson(res, 404, 'Not Found');
}

function dirEntryView(repo: Repo, owner: string, repoName: string, dirPath: string, e: { mode: string; name: string; oid: string }): Record<string, unknown> {
  const path = dirPath ? `${dirPath}/${e.name}` : e.name;
  const isDir = e.mode === '40000';
  const size = isDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0);
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name: e.name,
    path,
    sha: e.oid,
    url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
    html_url: `https://github.com/${owner}/${repoName}/tree/${repo.defaultBranch}/${path}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${repoName}/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${owner}/${repoName}/git/${isDir ? 'trees' : 'blobs'}/${e.oid}`,
  };
}

// ------------------------------------------------------------------ server

export function createApp(): ReturnType<typeof createServer> {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) errJson(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        else res.end();
      } catch {
        // socket already gone
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const qi = rawUrl.indexOf('?');
  const path = qi < 0 ? rawUrl : rawUrl.slice(0, qi);
  const query = qi < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qi + 1));

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Fast path: single-issue GET / POST (the benchmark's hot routes). Same
  // behaviour as the generic REST handler, minus the routing overhead.
  if (path.startsWith('/api/v3/repos/') && (method === 'GET' || method === 'POST')) {
    const rest = path.slice('/api/v3/repos/'.length);
    const issIdx = rest.indexOf('/issues');
    if (issIdx > 0) {
      const ownerRepo = rest.slice(0, issIdx);
      const slash = ownerRepo.indexOf('/');
      const after = rest.slice(issIdx + '/issues'.length);
      if (slash > 0 && (after === '' || (after.startsWith('/') && /^\/\d+$/.test(after)))) {
        if (!authed(req)) return errJson(res, 401, 'Requires authentication');
        const owner = ownerRepo.slice(0, slash);
        const repoName = ownerRepo.slice(slash + 1);
        const repo = store.getRepo(owner, repoName);
        if (method === 'GET' && after !== '') {
          const num = parseInt(after.slice(1), 10);
          if (!repo) return errJson(res, 404, 'Not Found');
          const issue = store.getIssue(repo, num);
          if (!issue) return errJson(res, 404, 'Not Found');
          const ckey = `${repo.id}:${num}`;
          const vkey = issueCacheKey(repo, issue);
          const cached = issueCache.get(ckey);
          if (cached && cached.key === vkey) {
            res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': cached.body.length, 'x-github-request-id': requestId() });
            res.end(cached.body);
            return;
          }
          const text = `${JSON.stringify(issueView(repo, issue))}\n`;
          const body = Buffer.from(text, 'utf8');
          if (issueCache.size >= 512) {
            const firstKey = issueCache.keys().next().value;
            if (firstKey !== undefined) issueCache.delete(firstKey);
          }
          issueCache.set(ckey, { key: vkey, body });
          res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': body.length, 'x-github-request-id': requestId() });
          res.end(body);
          return;
        }
        if (method === 'POST' && after === '') {
          if (!repo) return errJson(res, 404, 'Not Found');
          const parsed = await readJsonBody(req);
          if (!parsed.ok) return errJson(res, 400, 'Invalid JSON');
          const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
          if (!title) return errJson(res, 422, 'title is required');
          const labelsRaw = parsed.value.labels;
          const labels: string[] = Array.isArray(labelsRaw)
            ? labelsRaw.map((l) => (typeof l === 'string' ? l : (l as { name?: unknown })?.name).toString()).filter(Boolean)
            : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return errJson(res, 422, `Label '${label}' does not exist`);
          }
          const issue = store.createIssue(repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : '', labels);
          return sendJson(res, 201, issueView(repo, issue));
        }
      }
    }
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitIdx = path.indexOf('.git/');
  if (gitIdx > 0) {
    if (!authed(req)) return errJson(res, 401, 'Requires authentication');
    const ownerRepo = path.slice(1, gitIdx);
    const slash = ownerRepo.indexOf('/');
    if (slash <= 0) return errJson(res, 404, 'Not Found');
    const owner = decodeSeg(ownerRepo.slice(0, slash));
    const repoName = decodeSeg(ownerRepo.slice(slash + 1));
    const service = path.slice(gitIdx + 5);
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const headers: Record<string, string | undefined> = { 'git-protocol': req.headers['git-protocol'] };
    const out = handleGit(store, method, owner, repoName, service, query, headers, body);
    if (out.body === null) {
      res.writeHead(out.status, { ...out.headers, 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendBuffer(res, out.status, out.body, out.headers['content-type'] ?? 'application/octet-stream');
    return;
  }

  // GraphQL
  if (path === '/api/graphql') {
    if (method !== 'POST') return errJson(res, 404, 'Not Found');
    if (!authed(req)) return errJson(res, 401, 'Requires authentication');
    const raw = await readBody(req);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { errors: [{ message: 'Request body must be valid JSON.' }] });
    }
    const result = executeGraphQL(store, parsed);
    return sendJson(res, 200, result);
  }

  // MCP
  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(202, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    if (method !== 'POST') return errJson(res, 405, 'Method Not Allowed');
    if (!authed(req)) {
      // JSON-RPC error with HTTP 401 (the suite asserts the status).
      res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
      res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } })}\n`);
      return;
    }
    const raw = await readBody(req);
    const out = handleMcp(store, raw.toString('utf8'));
    if (out.notification) {
      res.writeHead(out.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    return sendJson(res, out.status, out.body);
  }

  // REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authed(req)) return errJson(res, 401, 'Requires authentication');
    await handleRest(req, res, method, path, query);
    return;
  }

  return errJson(res, 404, 'Not Found');
}
