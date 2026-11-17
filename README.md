# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bmbngn/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bmbngn/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in Node.js, standard library only — no dependencies, no build step, no git binary. It serves git smart HTTP (protocol v2 and v0), REST v3, GraphQL v4 and MCP (Streamable HTTP) from one in-memory store, so a repository pushed over git is the same repository the REST, GraphQL and MCP surfaces read back.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

Node 22.18 or newer. The process binds an ephemeral port, registers it with the trial environment at `$MAKEFUN_ENV_URL`, serves until the environment says done, then exits 0.

## Layout

- `main.ts` — entry ↔ environment lifecycle (bind, register, poll `/done`). Unchanged from the starter.
- `app.ts` — HTTP server: routing, auth, REST v3, GraphQL and MCP dispatch.
- `git-http.ts` — git smart HTTP: v2/v0 advertisements, `ls-refs`, `fetch` (including shallow and deepen), `receive-pack` with fast-forward enforcement and per-ref reports.
- `git.ts` — git primitives: SHA-1 objects, pkt-line codec, packfile read/write (plain and delta).
- `store.ts` — the in-memory store: repositories, objects, refs, issues, pull requests, labels, comments, contents, three-way merges.
- `graphql.ts` — a small GraphQL executor for the documents `gh` and `github-mcp-server` send (viewer, repository, issues, pull requests, mutations, introspection, node ids).
- `mcp.ts` — MCP Streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (create/get repo, issues, pull requests).

## Notes

- Auth is one bearer token, `$MAKEFUN_SHOP_TOKEN`. The token names the viewer (`adaiversen` in the trial scenario); the same repository name under another owner is a 404, never a 403.
- Everything is in memory: restarting the process starts with an empty forge.

---

<sub>Entered on [make.fun](https://make.fun/?ref=escmq3aq&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
