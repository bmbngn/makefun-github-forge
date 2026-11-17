// MCP Streamable HTTP: JSON-RPC 2.0 at /mcp. Modern era (server/discover, 2026-07-28)
// plus the legacy initialize handshake. Stateless, no session ids.
import { Store, VIEWER } from './store.ts';

export const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    }),
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        number: { type: 'integer', description: 'Issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    }),
  }),
  Object.freeze({
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Pull request state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    }),
  }),
]);

const SERVER_INFO = Object.freeze({ name: 'github-forge', version: '1.0.0' });

interface RpcError { code: number; message: string; data?: unknown }
type RpcResult = { result: unknown } | { error: RpcError };

function repoJson(store: Store, repo: ReturnType<Store['getRepo']> & object): Record<string, unknown> {
  const r = repo as NonNullable<ReturnType<Store['getRepo']>>;
  return {
    id: r.id,
    node_id: r.globalId,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: r.owner === VIEWER.login ? VIEWER.id : 0 },
    private: r.private,
    description: r.description,
    default_branch: r.defaultBranch,
    html_url: `https://github.com/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function issueJson(repoOwner: string, repoName: string, issue: ReturnType<Store['createIssue']>): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user },
    html_url: `https://github.com/${repoOwner}/${repoName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repoOwner}/${repoName}/issues/${issue.number}`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function pullJson(repoOwner: string, repoName: string, pull: NonNullable<ReturnType<Store['getPull']>>): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    user: { login: pull.user },
    html_url: `https://github.com/${repoOwner}/${repoName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repoOwner}/${repoName}/pulls/${pull.number}`,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): RpcResult {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const missing = (fields: string[]): RpcResult | null => {
    const bad = fields.filter((f) => args[f] === undefined || args[f] === null || args[f] === '');
    if (!bad.length) return null;
    return { result: { content: [{ type: 'text', text: JSON.stringify({ error: `missing required argument(s): ${bad.join(', ')}` }) }], isError: true } };
  };
  const toolError = (message: string): RpcResult => ({
    result: { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true },
  });
  const ok = (obj: unknown): RpcResult => ({
    result: { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj },
  });

  switch (name) {
    case 'create_repo': {
      const miss = missing(['name']);
      if (miss) return miss;
      const owner = str(args.owner) || VIEWER.login;
      const res = store.createRepo(owner, str(args.name), {
        description: str(args.description),
        private: args.private === true,
      });
      if (!res.repo) return toolError(`repository ${owner}/${str(args.name)} already exists`);
      return ok(repoJson(store, res.repo));
    }
    case 'get_repo': {
      const miss = missing(['owner', 'repo']);
      if (miss) return miss;
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      return ok(repoJson(store, repo));
    }
    case 'create_issue': {
      const miss = missing(['owner', 'repo', 'title']);
      if (miss) return miss;
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const issue = store.createIssue(repo, str(args.title), str(args.body), []);
      return ok(issueJson(repo.owner, repo.name, issue));
    }
    case 'list_issues': {
      const miss = missing(['owner', 'repo']);
      if (miss) return miss;
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const state = String(args.state ?? 'open').toLowerCase();
      const list = repo.issues.filter((i) => state === 'all' ? true : i.state === state);
      return ok({ issues: list.map((i) => issueJson(repo.owner, repo.name, i)) });
    }
    case 'get_issue': {
      const miss = missing(['owner', 'repo', 'number']);
      if (miss) return miss;
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const issue = store.getIssue(repo, Number(args.number));
      if (!issue) return toolError(`issue #${String(args.number)} not found`);
      return ok(issueJson(repo.owner, repo.name, issue));
    }
    case 'create_pull_request': {
      const miss = missing(['owner', 'repo', 'title', 'head', 'base']);
      if (miss) return miss;
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const res = store.createPull(repo, str(args.title), str(args.body), str(args.head), str(args.base));
      if (!res.pull) return toolError(res.error ?? 'could not create pull request');
      return ok(pullJson(repo.owner, repo.name, res.pull));
    }
    case 'merge_pull_request': {
      const miss = missing(['owner', 'repo', 'pull_number']);
      if (miss) return miss;
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const pull = store.getPull(repo, Number(args.pull_number));
      if (!pull) return toolError(`pull request #${String(args.pull_number)} not found`);
      const res = store.mergePull(repo, pull);
      if ('error' in res) return toolError(res.error);
      return ok({ merged: true, number: pull.number, sha: res.sha, message: 'Pull request successfully merged' });
    }
    case 'list_pull_requests': {
      const miss = missing(['owner', 'repo']);
      if (miss) return miss;
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const state = String(args.state ?? 'open').toLowerCase();
      const list = repo.pulls.filter((p) => state === 'all' ? true : p.state === state);
      return ok({ pull_requests: list.map((p) => pullJson(repo.owner, repo.name, p)) });
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

export interface McpOutcome {
  status: number;
  body: unknown;
  notification?: boolean;
}

/** Handle one MCP request. `rawBody` is the request text (may be malformed). */
export function handleMcp(store: Store, rawBody: string): McpOutcome {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
  const reply = (res: RpcResult, status = 200): McpOutcome => ({
    status,
    body: 'error' in res
      ? { jsonrpc: '2.0', id, error: res.error }
      : { jsonrpc: '2.0', id, result: res.result },
  });

  // Notifications (no id): no response body.
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null, notification: true };
  }

  switch (method) {
    case 'server/discover': {
      return reply({
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests.',
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      });
    }
    case 'initialize': {
      const offered = typeof (params as Record<string, unknown>).protocolVersion === 'string'
        ? (params as Record<string, unknown>).protocolVersion as string
        : '2025-11-25';
      const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
      return reply({
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
    }
    case 'tools/list': {
      return reply({ result: { tools: TOOLS } });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      return reply(callTool(store, toolName, args));
    }
    case 'ping': {
      return reply({ result: {} });
    }
    default: {
      return reply({ error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }
}
