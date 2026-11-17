// Git smart-HTTP handlers: info/refs advertisements (v2 + v0), v2 ls-refs/fetch,
// v0 fetch, and v0 receive-pack. Wire formats verified against sdk/conformance/git-client.ts.
import {
  ZERO_OID, pktLine, pktLines, FLUSH, DELIM, decodePktLines, readPack, writePack,
  parseCommit, parseTag, parseTree, collectReachable, type GitObject,
} from './git.ts';
import { Store, type Repo } from './store.ts';

const AGENT = 'github-forge/1.0';

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

function json404(message: string): GitResponse {
  return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8') };
}
function json400(message: string): GitResponse {
  return { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8') };
}

interface RefLine { oid: string; name: string; peeled?: string }

/** Sorted ref lines for a repo, with peeled targets for annotated tags. */
function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') entry.peeled = parseTag(obj.data).object;
    }
    out.push(entry);
  }
  return out;
}

function headTip(repo: Repo): string | null {
  return repo.refs.get('refs/heads/main') ?? null;
}

/** v0 advertisement body for a service. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT} symref=HEAD:refs/heads/main`
    : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = refLines(repo);
  const tip = headTip(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (tip !== null) {
      parts.push(pktLine(`${tip} HEAD${first ? `\0${caps}` : ''}\n`));
      first = false;
    }
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}${first ? `\0${caps}` : ''}\n`));
      first = false;
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
    if (first) parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, gitProtocol: string | undefined): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404('Not Found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: v2Advertisement() };
    }
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement' }, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return json404('Not Found');
}

// ---------------------------------------------------------------- ls-refs (v2)

function handleLsRefs(repo: Repo, body: Buffer): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return json400('malformed pkt-line stream');
  }
  let peel = false, symrefs = false, unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { seenDelim = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue; // command=/agent=/object-format= lines
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((pfx) => name.startsWith(pfx));
  const lines: Buffer[] = [];
  const tip = headTip(repo);
  if (symrefs && keep('HEAD')) {
    if (tip !== null) lines.push(pktLine(`${tip} HEAD symref-target:refs/heads/main\n`));
    else if (unborn) lines.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  for (const r of refLines(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel && r.peeled) line += ` peeled:${r.peeled}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(FLUSH);
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(lines) };
}

// ---------------------------------------------------------------- fetch selection

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Resolve a wanted oid to its commit (following a tag), remembering the tag oid. */
function resolveWant(repo: Repo, oid: string): { commit: string | null; tagOid: string | null } {
  const obj = repo.objects.get(oid);
  if (!obj) return { commit: null, tagOid: null };
  if (obj.type === 'tag') {
    const target = parseTag(obj.data).object;
    const targetObj = repo.objects.get(target);
    return { commit: targetObj && targetObj.type === 'commit' ? target : null, tagOid: oid };
  }
  if (obj.type === 'commit') return { commit: oid, tagOid: null };
  return { commit: null, tagOid: null };
}

function selectFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, prevShallow: string[]): FetchSelection {
  const tagOids: string[] = [];
  const wantCommits: string[] = [];
  for (const w of wants) {
    const r = resolveWant(repo, w);
    if (r.tagOid) tagOids.push(r.tagOid);
    if (r.commit) wantCommits.push(r.commit);
  }
  // BFS depths from the wanted commits.
  const depths = new Map<string, number>();
  const queue: string[] = [];
  for (const c of wantCommits) {
    if (!depths.has(c)) { depths.set(c, 0); queue.push(c); }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const d = depths.get(cur)!;
    // With a depth limit, only expand commits whose parents could still be
    // within the limit (depth < N-1 expands to depth N-1 at most). Without
    // this, a depth-1 clone of a 200-commit repo walks all 200 ancestors.
    if (depth !== null && d >= depth - 1) continue;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!depths.has(p)) { depths.set(p, d + 1); queue.push(p); }
    }
  }
  const includedCommits = [...depths.entries()]
    .filter(([, d]) => depth === null || d < depth)
    .map(([oid]) => oid);
  const includedSet = new Set(includedCommits);
  const shallow = depth === null
    ? []
    : includedCommits.filter((oid) => depths.get(oid) === depth - 1);
  const shallowSet = new Set(shallow);
  const unshallow = prevShallow.filter((oid) => includedSet.has(oid) && !shallowSet.has(oid));

  // Objects: tree closure of each included commit, plus tag objects.
  // With a depth limit, parent commits are NOT included (only the included
  // commits and their trees/blobs); without one, the full reachable closure.
  const wanted = new Set<string>();
  if (depth === null) {
    for (const c of includedCommits) {
      for (const oid of collectReachable([c], (o) => repo.objects.get(o))) wanted.add(oid);
    }
  } else {
    const addTree = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length) {
        const cur = stack.pop()!;
        if (wanted.has(cur)) continue;
        const obj = repo.objects.get(cur);
        if (!obj || obj.type !== 'tree') continue;
        wanted.add(cur);
        for (const e of parseTree(obj.data)) {
          if (e.mode === '40000') stack.push(e.oid);
          else wanted.add(e.oid);
        }
      }
    };
    for (const c of includedCommits) {
      wanted.add(c);
      const obj = repo.objects.get(c);
      if (obj && obj.type === 'commit') addTree(parseCommit(obj.data).tree);
    }
  }
  for (const t of tagOids) wanted.add(t);
  // Held set: everything reachable from the haves, EXCEPT that a shallow
  // boundary commit is held itself (commit + tree + blobs) but its parents
  // are not — the client only has the boundary, not its ancestry. Without
  // this, a deepen fetch would wrongly treat the parent as already held.
  const prevShallowSet = new Set(prevShallow);
  const held = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length) {
      const oid = stack.pop()!;
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const { tree, parents } = parseCommit(obj.data);
        const treeObj = repo.objects.get(tree);
        if (treeObj && treeObj.type === 'tree') {
          const tstack = [tree];
          while (tstack.length) {
            const t = tstack.pop()!;
            if (held.has(t)) continue;
            const tobj = repo.objects.get(t);
            if (!tobj || tobj.type !== 'tree') continue;
            held.add(t);
            for (const e of parseTree(tobj.data)) {
              if (e.mode === '40000') tstack.push(e.oid);
              else held.add(e.oid);
            }
          }
        }
        if (!prevShallowSet.has(oid)) stack.push(...parents);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }
  for (const h of held) wanted.delete(h);
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------- fetch (v2 + v0)

function handleFetch(repo: Repo, body: Buffer, v2: boolean): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return json400('malformed pkt-line stream');
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (/^[0-9a-f]{40}$/i.test(oid)) wants.push(oid.toLowerCase());
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (/^[0-9a-f]{40}$/i.test(oid)) haves.push(oid.toLowerCase());
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  if (wants.length === 0) {
    // Nothing wanted: answer an empty fetch.
    if (v2) {
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH]) };
    }
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat([pktLine('NAK\n'), FLUSH]) };
  }
  const sel = selectFetch(repo, wants, haves, depth, shallow);
  if (v2) {
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM];
    if (sel.shallow.length || sel.unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of sel.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(DELIM);
    }
    if (sel.objects.length) {
      const pack = writePack(sel.objects);
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPack(pack));
    }
    parts.push(FLUSH);
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(parts) };
  }
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of sel.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (sel.objects.length) {
    const pack = writePack(sel.objects);
    parts.push(...sidebandPack(pack));
  }
  parts.push(FLUSH);
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand { oldOid: string; newOid: string; ref: string }

function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  // Split the pkt-line command section from the raw pack that follows the flush.
  let commands: PushCommand[] = [];
  let packStart = body.length;
  try {
    let off = 0;
    let first = true;
    while (off + 4 <= body.length) {
      const len = parseInt(body.toString('ascii', off, off + 4), 16);
      if (Number.isNaN(len) || len < 0) return json400('malformed pkt-line stream');
      if (len === 0) { packStart = off + 4; break; }
      if (len < 4 || off + len > body.length) return json400('truncated pkt-line stream');
      const payload = body.toString('utf8', off + 4, off + len);
      const nul = payload.indexOf('\0');
      const text = (nul >= 0 && first ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = text.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0]!.toLowerCase(), newOid: parts[1]!.toLowerCase(), ref: parts.slice(2).join(' ') });
      }
      first = false;
      off += len;
    }
  } catch {
    return json400('malformed pkt-line stream');
  }
  if (commands.length === 0) return json400('no push commands');

  const reportEntries: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const packBytes = body.subarray(packStart);
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, obj] of read.objects) repo.objects.set(oid, obj);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpacker error';
      }
    }
  }
  if (!unpackOk) {
    for (const c of commands) reportEntries.push({ ref: c.ref, ok: false, reason: unpackDetail });
  } else {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportEntries.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          reportEntries.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(cmd.ref);
          reportEntries.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        reportEntries.push({ ref: cmd.ref, ok: false, reason: 'unable to read new object' });
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportEntries.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          reportEntries.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update: old must be the current tip and an ancestor of new.
      if (current === undefined || current !== cmd.oldOid) {
        reportEntries.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        reportEntries.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportEntries.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  }
  repo.updatedAt = new Date().toISOString();
  const innerLines: Array<string | 'flush'> = [`unpack ${unpackDetail}\n`];
  for (const e of reportEntries) {
    innerLines.push(e.ok ? `ok ${e.ref}\n` : `ng ${e.ref} ${e.reason}\n`);
  }
  innerLines.push('flush');
  const inner = pktLines(innerLines);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: outer };
}

// ---------------------------------------------------------------- dispatch

export function handleGit(
  store: Store,
  method: string,
  owner: string,
  repoName: string,
  service: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (method === 'GET' && service === 'info/refs') {
    return handleInfoRefs(store, owner, repoName, query.get('service') ?? '', headers['git-protocol']);
  }
  if (!repo) return json404('Not Found');
  if (method === 'POST' && service === 'git-upload-pack') {
    const gitProtocol = headers['git-protocol'];
    if (gitProtocol === 'version=2') {
      // v2: first data line decides ls-refs vs fetch.
      let firstLine = '';
      try {
        const packets = decodePktLines(body);
        for (const p of packets) {
          if (p.kind === 'data') { firstLine = p.payload.toString('utf8'); break; }
        }
      } catch {
        return json400('malformed pkt-line stream');
      }
      if (firstLine.startsWith('command=ls-refs')) return handleLsRefs(repo, body);
      if (firstLine.startsWith('command=fetch')) return handleFetch(repo, body, true);
      return json400('unknown v2 command');
    }
    return handleFetch(repo, body, false);
  }
  if (method === 'POST' && service === 'git-receive-pack') {
    return handleReceivePack(store, repo, body);
  }
  return json404('Not Found');
}
