# Project notes — github-core-clone-01

## Node version (IMPORTANT)
This bounty requires **Node 22**. This VM's PATH node is v24 — do NOT use it for this project.
Use the workspace Node 22 for every kit/test/entry run:

    ~/workspace/node22/bin/node --experimental-strip-types <file.ts>

Verified: `~/workspace/node22/bin/node --version` -> v22.23.5 (official linux-x64 tarball in ~/workspace/node22/).
Entry code must be Node-22 compatible, **stdlib only** — nothing is installed before the entry runs.

## Local suite (ground truth, from the kit)
Start the app (dev runner listens on 8791), then from ~/workspace/makefun/kit-clone:

    ~/workspace/node22/bin/node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8791 --token devtoken --json
    # add --perf for the four timed workloads

120 checks: git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5.
feature = round(600 * passed/120); agent = round(200 * mcpPassed/15); perf <= 200. Total 1000.
