// Minimal GraphQL v4 executor for the exact documents gh / github-mcp-server send.
// No dependencies: small tokenizer + parser + schema-driven resolver.
import { Store, VIEWER, decodeGlobalId, type Repo, type Issue, type Pull } from './store.ts';

// ------------------------------------------------------------------ tokenizer

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('{}():$![]=|&'.includes(c)) { toks.push({ kind: 'punct', value: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1, out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '"' ? '"' : e === '\\' ? '\\' : e === '/' ? '/' : e;
          j += 2;
        } else { out += src[j]!; j++; }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j++;
      while (/[0-9]/.test(src[j] ?? '')) j++;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j++; while (/[0-9]/.test(src[j] ?? '')) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (/[0-9]/.test(src[j] ?? '')) j++;
      }
      toks.push(isFloat ? { kind: 'float', value: src.slice(i, j) } : { kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (/[_A-Za-z0-9]/.test(src[j] ?? '')) j++;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return toks;
}

// ------------------------------------------------------------------ AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface SelectionNode {
  kind: 'field' | 'inlineFragment' | 'fragmentSpread';
  alias?: string;
  name?: string;
  typeCondition?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  selections?: SelectionNode[];
}

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs?: Array<{ name: string; type: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos++;
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${JSON.stringify(t)}`);
  }
  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(t)}`);
    if (v !== undefined && t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
    return t.value;
  }
  private maybePunct(v: string): boolean {
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === v) { this.pos++; return true; }
    return false;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.toks.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', selections: this.parseSelections() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | undefined;
        const nt = this.peek();
        if (nt?.kind === 'name') name = this.next().value;
        const varDefs = this.maybePunct('(') ? this.parseVarDefs() : undefined;
        operations.push({ kind, name, varDefs, selections: this.parseSelections() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, this.parseSelections());
        void typeCondition;
      } else {
        throw new Error(`unexpected token ${JSON.stringify(t)}`);
      }
    }
    return { operations, fragments };
  }

  private parseVarDefs(): Array<{ name: string; type: string; defaultValue?: ValueNode }> {
    const defs: Array<{ name: string; type: string; defaultValue?: ValueNode }> = [];
    while (!this.maybePunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.maybePunct('=')) defaultValue = this.parseValue(true);
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseType(): string {
    let type: string;
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
      this.expectPunct(']');
    } else {
      type = this.expectName();
    }
    if (this.maybePunct('!')) type += '!';
    return type;
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!this.maybePunct('}')) {
      const t = this.peek()!;
      if (t.kind === 'spread') {
        this.next();
        const nt = this.peek();
        if (nt?.kind === 'name' && nt.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          sels.push({ kind: 'inlineFragment', typeCondition, selections: this.parseSelections() });
        } else if (nt?.kind === 'name') {
          sels.push({ kind: 'fragmentSpread', name: this.next().value });
        } else {
          throw new Error('bad fragment spread');
        }
      } else if (t.kind === 'name') {
        const first = this.next().value;
        let alias: string | undefined;
        let name = first;
        if (this.maybePunct(':')) { alias = first; name = this.expectName(); }
        let args: Array<{ name: string; value: ValueNode }> | undefined;
        if (this.maybePunct('(')) args = this.parseArgs();
        let selections: SelectionNode[] | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') selections = this.parseSelections();
        sels.push({ kind: 'field', alias, name, args, selections });
      } else {
        throw new Error(`unexpected token in selection set ${JSON.stringify(t)}`);
      }
    }
    return sels;
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.maybePunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new Error('variable in const value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.maybePunct(']')) values.push(this.parseValue(isConst));
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.maybePunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// ------------------------------------------------------------------ value coercion

function coerceValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => coerceValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = coerceValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(sel: SelectionNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args ?? []) out[a.name] = coerceValue(a.value, variables);
  return out;
}

// ------------------------------------------------------------------ schema (introspection data)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'createdAt', 'updatedAt', 'url', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'repository', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ------------------------------------------------------------------ execution

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}
function seqFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function unknownField(ctx: Ctx, typeName: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return null;
}

type Obj = Record<string, unknown> | null;

function resolveSelections(
  ctx: Ctx,
  typeName: string,
  value: Obj | unknown[],
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  fragments: Map<string, SelectionNode[]>,
): Obj {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value as unknown as Obj;
  const obj = value as Obj;
  const out: Record<string, unknown> = {};
  let failed = false;
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      const sub = resolveSelections(ctx, typeName, obj, sel.selections ?? [], variables, fragments);
      if (sub) Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      const frag = fragments.get(sel.name ?? '');
      if (!frag) { ctx.errors.push({ message: `Unknown fragment "${sel.name}".` }); failed = true; continue; }
      const sub = resolveSelections(ctx, typeName, obj, frag, variables, fragments);
      if (sub) Object.assign(out, sub);
      continue;
    }
    const fieldName = sel.name!;
    const key = sel.alias ?? fieldName;
    const resolved = resolveField(ctx, typeName, obj, sel, variables, fragments);
    if (resolved === FIELD_ERROR) { failed = true; out[key] = null; continue; }
    out[key] = resolved;
  }
  return failed ? null : out;
}

const FIELD_ERROR = Symbol('field-error');

function resolveField(
  ctx: Ctx,
  typeName: string,
  obj: Record<string, unknown>,
  sel: SelectionNode,
  variables: Record<string, unknown>,
  fragments: Map<string, SelectionNode[]>,
): unknown {
  const field = sel.name!;
  const args = argsOf(sel, variables);
  const subs = sel.selections ?? [];

  const bad = (): unknown => {
    unknownField(ctx, typeName, field);
    return FIELD_ERROR;
  };

  switch (typeName) {
    case 'Query': return resolveQueryField(ctx, obj, sel, args, subs, variables, fragments, bad);
    case 'Mutation': return resolveMutationField(ctx, sel, args, subs, variables, fragments, bad);
    case 'User': {
      if (field === 'login') return obj.login;
      if (field === 'id') return obj.globalId ?? obj.id;
      if (field === 'name') return obj.name;
      if (field === 'email') return obj.email;
      if (field === 'avatarUrl') return '';
      if (field === 'url') return `https://github.com/${obj.login}`;
      return bad();
    }
    case 'Repository': return resolveRepositoryField(ctx, obj, sel, args, subs, variables, fragments, bad);
    case 'Issue': {
      const issue = obj.__issue as Issue | undefined;
      if (!issue) return bad();
      if (field === 'id') return issue.globalId;
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'body') return issue.body;
      if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'closedAt') return issue.closedAt;
      if (field === 'author') return resolveSelections(ctx, 'User', { login: issue.user, name: issue.user, email: `${issue.user}@example.invalid` }, subs, variables, fragments);
      if (field === 'labels') return (issue.labels ?? []).map((name) => ({ name }));
      if (field === 'url') return `https://github.com/${obj.__repoName}/issues/${issue.number}`;
      if (field === 'repository') return null;
      return bad();
    }
    case 'PullRequest': {
      const pull = obj.__pull as Pull | undefined;
      if (!pull) return bad();
      if (field === 'id') return pull.globalId;
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'merged') return pull.merged;
      if (field === 'mergeable') return ctx.store.pullMergeable(obj.__repo as Repo, pull);
      if (field === 'headRefName') return pull.head;
      if (field === 'baseRefName') return pull.base;
      if (field === 'headRef') return resolveSelections(ctx, 'Ref', { name: pull.head }, subs, variables, fragments);
      if (field === 'baseRef') return resolveSelections(ctx, 'Ref', { name: pull.base }, subs, variables, fragments);
      if (field === 'createdAt') return pull.createdAt;
      if (field === 'updatedAt') return pull.updatedAt;
      if (field === 'closedAt') return pull.mergedAt;
      if (field === 'mergedAt') return pull.mergedAt;
      if (field === 'author') return resolveSelections(ctx, 'User', { login: pull.user, name: pull.user, email: `${pull.user}@example.invalid` }, subs, variables, fragments);
      if (field === 'files') {
        const files = ctx.store.pullFiles(obj.__repo as Repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((f) => resolveSelections(ctx, 'PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes }, subs.find((s) => s.name === 'nodes')?.selections ?? [], variables, fragments));
        return { nodes, pageInfo: { hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: files.length };
      }
      if (field === 'url') return `https://github.com/${obj.__repoName}/pull/${pull.number}`;
      return bad();
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return obj.path;
      if (field === 'additions') return obj.additions;
      if (field === 'deletions') return obj.deletions;
      if (field === 'changes') return obj.changes;
      return bad();
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return obj.hasNextPage;
      if (field === 'hasPreviousPage') return obj.hasPreviousPage;
      if (field === 'startCursor') return obj.startCursor;
      if (field === 'endCursor') return obj.endCursor;
      return bad();
    }
    case 'IssueComment': {
      if (field === 'id') return obj.id;
      if (field === 'body') return obj.body;
      if (field === 'author') return resolveSelections(ctx, 'User', { login: obj.author ?? VIEWER.login, name: obj.author ?? VIEWER.login, email: `${obj.author ?? VIEWER.login}@example.invalid` }, subs, variables, fragments);
      if (field === 'createdAt') return obj.createdAt;
      if (field === 'updatedAt') return obj.updatedAt;
      if (field === 'url') return obj.url ?? null;
      return bad();
    }
    case 'IssueCommentEdge': {
      if (field === 'node') return resolveSelections(ctx, 'IssueComment', obj.node as Record<string, unknown>, subs, variables, fragments);
      if (field === 'cursor') return obj.cursor;
      return bad();
    }
    case 'Ref': {
      if (field === 'name') return obj.name;
      return bad();
    }
    case '__Schema': {
      if (field === 'queryType') return resolveSelections(ctx, '__Type', { name: 'Query', kind: 'OBJECT', fields: TYPE_FIELDS.Query ?? [], enumValues: [] }, subs, variables, fragments);
      if (field === 'mutationType') return resolveSelections(ctx, '__Type', { name: 'Mutation', kind: 'OBJECT', fields: TYPE_FIELDS.Mutation ?? [], enumValues: [] }, subs, variables, fragments);
      if (field === 'types') {
        return Object.keys(TYPE_FIELDS).map((n) => resolveSelections(ctx, '__Type', { name: n, kind: ENUM_VALUES[n] !== undefined ? 'ENUM' : 'OBJECT', fields: TYPE_FIELDS[n] ?? [], enumValues: ENUM_VALUES[n] ?? [] }, subs.find((s) => s.name === undefined)?.selections ?? subs, variables, fragments));
      }
      if (field === 'description') return null;
      return bad();
    }
    case '__Type': {
      if (field === 'name') return obj.name;
      if (field === 'kind') return obj.kind;
      if (field === 'description') return null;
      if (field === 'fields') {
        const names: string[] = (obj.fields as string[]) ?? [];
        return names.map((n) => ({ name: n, description: null, args: [], type: { name: 'String', kind: 'SCALAR' } }));
      }
      if (field === 'enumValues') {
        const names: string[] = (obj.enumValues as string[]) ?? [];
        return names.map((n) => ({ name: n, description: null }));
      }
      return bad();
    }
    case '__Field': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return { name: 'String', kind: 'SCALAR' };
      return bad();
    }
    case '__EnumValue': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      return bad();
    }
    default:
      return bad();
  }
}

function repoObject(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    __repo: repo,
    __repoName: `${repo.owner}/${repo.name}`,
    id: repo.globalId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    ownerLogin: repo.owner,
    defaultBranch: repo.defaultBranch,
    description: repo.description,
    private: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __issue: issue, __repo: repo, __repoName: `${repo.owner}/${repo.name}` };
}
function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __pull: pull, __repo: repo, __repoName: `${repo.owner}/${repo.name}` };
}

function resolveRepositoryField(
  ctx: Ctx,
  obj: Record<string, unknown>,
  sel: SelectionNode,
  args: Record<string, unknown>,
  subs: SelectionNode[],
  variables: Record<string, unknown>,
  fragments: Map<string, SelectionNode[]>,
  bad: () => unknown,
): unknown {
  const field = sel.name!;
  const repo = obj.__repo as Repo;
  if (field === 'id') return repo.globalId;
  if (field === 'databaseId') return repo.id;
  if (field === 'name') return repo.name;
  if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
  if (field === 'owner') return resolveSelections(ctx, 'User', { login: repo.owner, name: repo.owner, email: `${repo.owner}@example.invalid` }, subs, variables, fragments);
  if (field === 'defaultBranchRef') return resolveSelections(ctx, 'Ref', { name: repo.defaultBranch }, subs, variables, fragments);
  if (field === 'viewerPermission') return 'ADMIN';
  if (field === 'hasIssuesEnabled') return true;
  if (field === 'description') return repo.description;
  if (field === 'private') return repo.private;
  if (field === 'createdAt') return repo.createdAt;
  if (field === 'updatedAt') return repo.updatedAt;
  if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
  if (field === 'issue') {
    const n = args.number as number;
    const issue = repo.issues.find((i) => i.number === n);
    if (!issue) return null;
    return resolveSelections(ctx, 'Issue', issueObject(repo, issue), subs, variables, fragments);
  }
  if (field === 'issues') {
    const states = (args.states as string[] | undefined) ?? null;
    let list = [...repo.issues];
    if (states) {
      const want = new Set(states.map((s) => String(s).toUpperCase() === 'OPEN' ? 'open' : 'closed'));
      list = list.filter((i) => want.has(i.state));
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const dir = String(orderBy?.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
    const orderField = String(orderBy?.field ?? 'CREATED_AT').toUpperCase();
    if (orderField === 'COMMENTS') {
      list.sort((a, b) => dir * ((ctx.store.getRepo(repo.owner, repo.name)?.comments.get(a.number)?.length ?? 0) - (ctx.store.getRepo(repo.owner, repo.name)?.comments.get(b.number)?.length ?? 0)) || dir * (a.seq - b.seq));
    } else if (orderField === 'UPDATED_AT') {
      list.sort((a, b) => dir * (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.seq - b.seq));
    } else {
      list.sort((a, b) => dir * (a.seq - b.seq));
    }
    const afterSeq = seqFromCursor(args.after);
    if (afterSeq !== null) {
      list = dir === -1 ? list.filter((i) => i.seq < afterSeq) : list.filter((i) => i.seq > afterSeq);
    }
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    const nodesSel = subs.find((s) => s.name === 'nodes');
    const pageInfoSel = subs.find((s) => s.name === 'pageInfo');
    const nodes = page.map((i) => resolveSelections(ctx, 'Issue', issueObject(repo, i), nodesSel?.selections ?? [], variables, fragments));
    const pageInfo = pageInfoSel
      ? resolveSelections(ctx, 'PageInfo', {
          hasNextPage: list.length > first,
          hasPreviousPage: false,
          startCursor: page.length ? cursorFor(page[0]!.seq) : null,
          endCursor: page.length ? cursorFor(page[page.length - 1]!.seq) : null,
        }, pageInfoSel.selections ?? [], variables, fragments)
      : { hasNextPage: list.length > first, hasPreviousPage: false, startCursor: null, endCursor: null };
    return { nodes, pageInfo, totalCount: list.length };
  }
  if (field === 'pullRequests') {
    let list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    const nodesSel = subs.find((s) => s.name === 'nodes');
    const nodes = page.map((p) => resolveSelections(ctx, 'PullRequest', pullObject(repo, p), nodesSel?.selections ?? [], variables, fragments));
    return { nodes, pageInfo: { hasNextPage: list.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: list.length };
  }
  if (field === 'pullRequest') {
    const n = args.number as number;
    const pull = repo.pulls.find((p) => p.number === n);
    if (!pull) return null;
    return resolveSelections(ctx, 'PullRequest', pullObject(repo, pull), subs, variables, fragments);
  }
  return bad();
}

function resolveQueryField(
  ctx: Ctx,
  _obj: Record<string, unknown>,
  sel: SelectionNode,
  args: Record<string, unknown>,
  subs: SelectionNode[],
  variables: Record<string, unknown>,
  fragments: Map<string, SelectionNode[]>,
  bad: () => unknown,
): unknown {
  const field = sel.name!;
  if (field === 'viewer') {
    return resolveSelections(ctx, 'User', { login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, globalId: `User:${VIEWER.id}` }, subs, variables, fragments);
  }
  if (field === 'repository') {
    const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    if (!repo) return null;
    return resolveSelections(ctx, 'Repository', repoObject(ctx, repo), subs, variables, fragments);
  }
  if (field === 'node') {
    const decoded = decodeGlobalId(String(args.id ?? ''));
    if (!decoded) return null;
    if (decoded.kind === 'Repository') {
      const repo = ctx.store.reposById.get(parseInt(decoded.key, 10));
      if (!repo) return null;
      return resolveSelections(ctx, 'Repository', repoObject(ctx, repo), subs, variables, fragments);
    }
    if (decoded.kind === 'Issue') {
      const [repoId, num] = decoded.key.split(':');
      const repo = ctx.store.reposById.get(parseInt(repoId ?? '', 10));
      const issue = repo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
      if (!repo || !issue) return null;
      return resolveSelections(ctx, 'Issue', issueObject(repo, issue), subs, variables, fragments);
    }
    if (decoded.kind === 'PullRequest') {
      const [repoId, num] = decoded.key.split(':');
      const repo = ctx.store.reposById.get(parseInt(repoId ?? '', 10));
      const pull = repo?.pulls.find((p) => p.number === parseInt(num ?? '', 10));
      if (!repo || !pull) return null;
      return resolveSelections(ctx, 'PullRequest', pullObject(repo, pull), subs, variables, fragments);
    }
    return null;
  }
  if (field === '__type') {
    const name = String(args.name ?? '');
    const fields = TYPE_FIELDS[name];
    const enums = ENUM_VALUES[name];
    if (fields === undefined && enums === undefined) return null;
    return resolveSelections(ctx, '__Type', {
      name,
      kind: enums !== undefined ? 'ENUM' : 'OBJECT',
      fields: fields ?? [],
      enumValues: enums ?? [],
    }, subs, variables, fragments);
  }
  if (field === '__schema') {
    return resolveSelections(ctx, '__Schema', {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      types: Object.keys(TYPE_FIELDS).map((n) => ({ name: n })),
    }, subs, variables, fragments);
  }
  return bad();
}

function resolveMutationField(
  ctx: Ctx,
  sel: SelectionNode,
  args: Record<string, unknown>,
  subs: SelectionNode[],
  variables: Record<string, unknown>,
  fragments: Map<string, SelectionNode[]>,
  bad: () => unknown,
): unknown {
  const field = sel.name!;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'Repository' ? ctx.store.reposById.get(parseInt(decoded.key, 10)) : undefined;
    if (!repo) { ctx.errors.push({ message: 'Repository not found.' }); return FIELD_ERROR; }
    const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    const issueSel = subs.find((s) => s.name === 'issue');
    return { issue: issueSel ? resolveSelections(ctx, 'Issue', issueObject(repo, issue), issueSel.selections ?? [], variables, fragments) : { number: issue.number, id: issue.globalId } };
  }
  if (field === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (decoded?.kind !== 'Issue') { ctx.errors.push({ message: 'Issue not found.' }); return FIELD_ERROR; }
    const [repoId, num] = decoded.key.split(':');
    const repo = ctx.store.reposById.get(parseInt(repoId ?? '', 10));
    const issue = repo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
    if (!repo || !issue) { ctx.errors.push({ message: 'Issue not found.' }); return FIELD_ERROR; }
    issue.state = 'closed';
    issue.closedAt = new Date().toISOString();
    issue.updatedAt = issue.closedAt;
    const issueSel = subs.find((s) => s.name === 'issue');
    return { issue: issueSel ? resolveSelections(ctx, 'Issue', issueObject(repo, issue), issueSel.selections ?? [], variables, fragments) : { number: issue.number, id: issue.globalId, state: 'CLOSED' } };
  }
  if (field === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'Repository' ? ctx.store.reposById.get(parseInt(decoded.key, 10)) : undefined;
    if (!repo) { ctx.errors.push({ message: 'Repository not found.' }); return FIELD_ERROR; }
    const res = ctx.store.createPull(repo, String(input.title ?? ''), String((input as Record<string, unknown>).body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if (!res.pull) { ctx.errors.push({ message: res.error ?? 'Could not create pull request.' }); return FIELD_ERROR; }
    const prSel = subs.find((s) => s.name === 'pullRequest');
    return { pullRequest: prSel ? resolveSelections(ctx, 'PullRequest', pullObject(repo, res.pull), prSel.selections ?? [], variables, fragments) : { number: res.pull.number, id: res.pull.globalId } };
  }
  if (field === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (decoded?.kind !== 'PullRequest') { ctx.errors.push({ message: 'Pull request not found.' }); return FIELD_ERROR; }
    const [repoId, num] = decoded.key.split(':');
    const repo = ctx.store.reposById.get(parseInt(repoId ?? '', 10));
    const pull = repo?.pulls.find((p) => p.number === parseInt(num ?? '', 10));
    if (!repo || !pull) { ctx.errors.push({ message: 'Pull request not found.' }); return FIELD_ERROR; }
    const res = ctx.store.mergePull(repo, pull);
    if ('error' in res) { ctx.errors.push({ message: res.error }); return FIELD_ERROR; }
    const prSel = subs.find((s) => s.name === 'pullRequest');
    return { pullRequest: prSel ? resolveSelections(ctx, 'PullRequest', pullObject(repo, pull), prSel.selections ?? [], variables, fragments) : { number: pull.number, merged: true, state: 'MERGED' } };
  }
  if (field === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (decoded?.kind !== 'Issue') { ctx.errors.push({ message: 'Subject not found.' }); return FIELD_ERROR; }
    const [repoId, num] = decoded.key.split(':');
    const repo = ctx.store.reposById.get(parseInt(repoId ?? '', 10));
    const issue = repo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
    if (!repo || !issue) { ctx.errors.push({ message: 'Subject not found.' }); return FIELD_ERROR; }
    const comment = ctx.store.addComment(repo, issue.number, String(input.body ?? ''));
    if (!comment) { ctx.errors.push({ message: 'Could not add comment.' }); return FIELD_ERROR; }
    const edgeSel = subs.find((s) => s.name === 'commentEdge');
    const nodeSel = edgeSel?.selections?.find((s) => s.name === 'node');
    const node = nodeSel ? resolveSelections(ctx, 'IssueComment', { id: comment.globalId, body: comment.body }, nodeSel.selections ?? [], variables, fragments) : { id: comment.globalId, body: comment.body };
    return { commentEdge: { node, cursor: cursorFor(comment.id) } };
  }
  return bad();
}

// ------------------------------------------------------------------ entry

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(store: Store, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((item) => executeOne(store, item));
  }
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): GraphQLResult {
  const ctx: Ctx = { store, errors: [] };
  try {
    if (!body || typeof body !== 'object') return { errors: [{ message: 'Request body must be a JSON object.' }] };
    const { query, variables, operationName } = body as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof query !== 'string' || query.trim() === '') {
      return { errors: [{ message: 'Must provide query string.' }] };
    }
    const vars = (variables && typeof variables === 'object' ? variables : {}) as Record<string, unknown>;
    const { operations, fragments } = new Parser(tokenize(query)).parseDocument();
    const op = typeof operationName === 'string'
      ? operations.find((o) => o.name === operationName)
      : operations[0];
    if (!op) return { errors: [{ message: `Unknown operation named "${String(operationName)}".` }] };
    if (op.kind === 'subscription') return { errors: [{ message: 'Subscriptions are not supported.' }] };
    // Apply variable defaults.
    for (const def of op.varDefs ?? []) {
      if (vars[def.name] === undefined && def.defaultValue !== undefined) {
        vars[def.name] = coerceValue(def.defaultValue, vars);
      }
    }
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = resolveSelections(ctx, rootType, {}, op.selections, vars, fragments);
    const result: GraphQLResult = { data };
    if (ctx.errors.length) result.errors = ctx.errors;
    return result;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
