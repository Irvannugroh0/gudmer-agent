# github-core-clone-01 — build progress

**Status: the local suite passes 120/120 and the perf column measures ~148–156 across
runs on this shared VM (median ~152, total ~948–956; the 909 recorded at pass 5 was the
same code under heavier VM load). Not submitted — submission is a later, separate step
(GitHub repo route: push this repo to the user's GitHub, bundle the recorded sessions,
`makefun check`, submit once). Entries close 2026-11-21 13:30 WIB.**

## How to run the local suite

Use **Node 22** (`~/workspace/node22/bin/node`, see NOTES.md — the VM's PATH node is v24):

```sh
# serve the entry (dev runner importing createApp from app.ts, port 8791)
MAKEFUN_SHOP_TOKEN=devtoken ~/workspace/node22/bin/node --experimental-strip-types /tmp/dev-server.ts
# in ~/workspace/makefun/kit-clone:
~/workspace/node22/bin/node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8791 --token devtoken [--perf] [--json]
```

⚠️ Always run the suite against a **freshly started server**. The suite assumes a fresh,
empty forge (the trial boots one per run); re-running it against a stateful server fails
setup pushes with `stale ref` because its fixture repos already exist.

## Suite results per pass

| Pass | What landed | Checks | Score |
|---|---|---|---|
| baseline | kit starter (healthz + API root only) | 3/120 (repos 2, protocol 1) | 15 |
| 1 | full REST v3 (repos, contents, labels, issues, pulls) + protocol discipline | 56/120 — repos 15/15, issues 15/15, pulls 20/20, protocol 5/5 | 280 |
| 2 | MCP endpoint (server/discover + legacy initialize, 6 tools) | 71/120 — mcp 15/15 | 555 (agent 200/200) |
| 3 | git smart HTTP (v0+v2, ls-refs, fetch + shallow/deepen, receive-pack) | 101/120 — git 30/30 | 705 |
| 4 | GraphQL v4 (parser/validator/executor, introspection, node ids, mutations, batching, cursor pagination) | **120/120** | 800 (feature 600/600) |
| 5 | perf: removed a full-history walk from shallow fetch planning; pack deflate level 1 | 120/120 + perf 109/200 | **909** |
| 6 | perf: early-exit fast-forward check (was a full ancestry walk per push), commit-parse memo, pack-entry/pack/fetch-response memoisation, static v2 advertisement, leaner sendJson | 120/120 + perf ~148–156/200 across runs | **~948–956** |

Perf detail (points = `round(clamp(25 − 12.5·log2(p50/T_ref), 0, 50))` per workload;
T_ref = the reference forge's medians on the production cluster). Pass 6 was A/B-measured
against pass 5 with interleaved runs on this shared 1.5-CPU VM (bench client co-located),
p50 medians across 4–5 samples each:

| Workload | Pass 5 p50 median | Pass 6 p50 median | T_ref p50 | Pass 6 points (typical) |
|---|---|---|---|---|
| push (200 sequential 1 KiB pushes) | ~686 ms | **~533 ms** | 1,641 ms | 44–47 |
| clone (50 concurrent shallow clones, 200-commit repo) | ~203 ms | ~210 ms (noise band) | 267 ms | 27–33 |
| read (2,000 GET issue) | ~1,166 ms | ~1,240 ms (noise band) | 2,760 ms | 38–41 |
| write (200 POST issues) | ~157 ms | ~160 ms (noise band) | 349 ms | 38–40 |

An in-process profile (handlers called directly, no HTTP) shows why only push moved:
the entry's own JS is 0.005 ms per read, 0.021 ms per write, ~0.12 ms per clone set and
~0.21 ms per push exchange — 3–8% of the measured wall time. The rest is HTTP transport
plus the co-located bench client contending for the same 1.5 CPUs, which no server-side
change can remove locally. The pass-6 wins are structural (a quadratic history walk and
repeated pack/fetch recomputation are gone), so they should weigh more on the production
cluster, where the trial's CPU is dedicated and T_ref was measured.

## Architecture

One in-memory store (`store.ts`: a content-addressed git object store — SHA-1
blob/tree/commit/tag with real tree/commit encoding — plus repos, refs, labels, issues,
pulls) shared by four surfaces, so an object is the same object on every surface:

- `rest.ts` — REST v3: root/meta/rate_limit/user, user/repos (+ Link pagination),
  repos CRUD, branches, commits, git/refs, contents (with the 409 stale-sha rule),
  labels, issues + comments, pulls + files + merge (squash/merge, 405 on conflict).
- `git.ts` — smart HTTP: v0 and v2 advertisement, v2 ls-refs (peel/symrefs/unborn/
  ref-prefix), fetch (haves exclusion, shallow/deepen with boundary reporting, sideband
  framing), receive-pack (pack ingest with delta resolution, per-ref report-status,
  `non-fast-forward` refusals). Outgoing packs carry plain objects, no deltas.
- `graphql.ts` — a hand-rolled lexer/parser/validator/executor for the exact document
  shapes gh and github-mcp-server send; global ids are base64 payloads
  (`Repository:<id>`, `Issue:<repoId>:<number>`, …), opaque and stable.
- `mcp.ts` — streamable-HTTP MCP: modern `server/discover` plus the legacy initialize
  handshake; the six github-mcp-server tools over the same store.
- `app.ts` — routing, bearer auth (401), `X-GitHub-Request-Id` on every reply,
  malformed-JSON 400 on API routes, JSON 404s. `main.ts` is the kit's lifecycle, untouched.

## Spec decisions worth remembering

- **Owner-login adoption.** The entry cannot know the token owner's login up front, so
  repos created via `POST /user/repos` sit under a pending owner; the first
  `/repos/{owner}/…` (or git) path that resolves one by name adopts that owner as the
  viewer login and re-keys. A different owner afterwards 404s (the stranger-repo rule).
- **Deterministic store clock.** Server-made commits tick +60 s from a fixed epoch, so
  commit ids are reproducible run over run.
- **receive-pack is v0-only** (the client requires it); upload-pack honours
  `Git-Protocol: version=2` (advertise-v2 fails a v0 answer). Push report goes in
  sideband band 1 when the client negotiated side-band-64k.
- **Shallow correctness.** The haves-exclusion walk stops at the client's declared
  shallow boundary (`closureWithinShallow`); a naive full closure makes deepen a no-op.
- **GraphQL validation errors** are HTTP 200 with an `errors` array naming the field;
  an unknown repository is `data.repository = null` with no errors.
- **Issues and PRs share one number sequence** per repo (REST rule), but live in
  separate maps; the REST issues list therefore never shows PRs, which the suite expects.
- **Memoisation is sound because objects are content-addressed** (pass 6). Stored
  objects are immutable and only ever added, so: parsed commits are memoised per id;
  pack entries and whole packs are memoised per exact oid set; fetch responses are
  memoised per (protocol, object count, canonical args) — any push grows the count
  and forces recomputation, and a fetch answer depends on nothing else. The
  fast-forward check uses `isAncestor`, an early-exit walk, instead of materialising
  the new tip's whole ancestry on every push (that was O(chain) per push, O(n²) per
  bench round).

## Remaining work

1. **Submission (later, user-gated):** push this repo to the user's GitHub
   (github.com/Irvannugroh0/gudmer-agent or a fresh repo created after the competition's
   opensAt), bundle the recorded Muse sessions + usage rows from the kit CLI, run
   `makefun check`, submit once with the burner keypair. Deadline 21 Nov 13:30 WIB.
2. **Perf headroom:** locally the entry is at the transport floor (see the pass-6
   profile above): per-workload medians swing ±30% with VM load, so local perf points
   are indicative only. Any further gain would have to come from the production
   environment differing (dedicated CPU), not from more server code.
3. **Trial-shape check before submitting:** boot once through `main.ts` against a real
   env registration (the kit's gateway) to confirm the register/serve/heartbeat cycle —
   locally only the no-env path was smoke-tested (exits cleanly with a clear message).
