---
title: Database connections
description: How Liaison sizes its database connection pools from one budget, when a process refuses to boot, and how to read the pools on /diag.
---

Every Liaison process opens a few PostgreSQL connection pools. With a connection budget set, each process sizes its pools from that budget and from its role, so the whole deployment fits the database's connection limit, a rolling deploy included. This page explains the pools, the budget, the boot checks and the `/diag` gauges.

## The pools

A process has up to five pools:

| Pool | What uses it |
|---|---|
| main | Logins, setup and anything outside a request or a job. |
| request | Every HTTP request and MCP call (row-level security). |
| privileged | Short privileged reads and writes: auth checks, connection tokens, system queries. Agent and cron jobs run their privileged work here too. |
| jobs | Background jobs, webhook retries and app event handlers. |
| privileged-jobs | Privileged transactions of background work. |

The request and jobs pools log in as a separate, unprivileged login when `DATABASE_REQUEST_PASSWORD` is set (split logins). Without it there are three pools: request is the main pool, and privileged-jobs is the jobs pool.

## Set the budget

Set `DB_CELL_MAX_CONNECTIONS` to the number of connections Liaison may open on its database: Postgres `max_connections`, or your pooler's client limit. The compose `api` and `worker` services set it from `POSTGRES_MAX_CONNECTIONS` (200 by default). If you run on an external database, set it to that database's limit.

From the budget, a process takes away:

- `DB_CELL_RESERVED` (15 by default) for superuser slots, psql and monitoring;
- 13 for the `migrate` one-shot, which connects while the old processes still hold theirs.

What remains is the available budget. With the defaults: 200 - 15 - 13 = 172.

Each process then counts the whole topology: `LIAISON_API_REPLICAS` api processes (2 by default) and `LIAISON_WORKER_REPLICAS` workers (1 by default). The compose file fills both from `API_REPLICAS` and `WORKER_REPLICAS` in `deploy/.env`, the same values `deploy/rolling-deploy.sh` scales to.

Without `DB_CELL_MAX_CONNECTIONS` nothing is planned: the pools keep their old sizes (`DB_POOL_MAX` and the others, or 20), and nothing refuses to boot.

## How the pools are sized

Each role starts from a floor:

| Role | main | request | privileged | jobs | privileged-jobs |
|---|---|---|---|---|---|
| api (split logins) | 5 | 6 | 10 | 3 | 2 |
| worker (split logins) | 5 | 7 | 15 | 3 | 2 |

The api's privileged floor of 10 is room for two conversation views opening at once, each with its customer card, beside auth checks. Its jobs pool fits two app event handlers at once (they run in the process that published the event, usually an api) plus one connection for short work such as inbound webhooks. The worker's privileged pool is the kernel's job slots (cron 2, agent 4, media 2, bulk 1, webhook 1, plus one) and 4 for nested reads; the kernel never runs more job slots than the pool fits.

What the budget leaves above the floors goes, in this order:

1. the worker's jobs pool, up to what its whole-run jobs can hold at once plus 2;
2. with split logins, the worker's privileged-jobs pool;
3. each api's request and privileged pools, one connection at a time, up to 25 and 20.

Anything left is reported as unallocated. With the defaults and split logins, an api process opens 26 connections and the worker 34: one release needs 2 x 26 + 34 = 86, and two releases side by side need 172, exactly the available budget.

A pool you set in env wins over the plan: `DB_POOL_MAX` (request), `DB_PRIVILEGED_POOL_MAX`, `DB_JOBS_POOL_MAX` and `DB_PRIVILEGED_JOBS_POOL_MAX`. In compose, set them as `API_DB_POOL_MAX`, `WORKER_DB_POOL_MAX` and so on in `deploy/.env`; empty means planned. The single-container `app` service keeps its own sizes (25, 15, 30). The `migrate` one-shot and CLI commands use 2 connections per pool.

## When a process refuses to boot

Right after it starts, each process logs one `pool_plan` line with its pools and the topology's numbers. Then:

- **One release does not fit** (steady above the available budget): the process logs `pool_budget_exceeded`, names every pool and its size, and exits with code 1 before it opens Redis or HTTP. Raise the budget and the database's limit, lower the replicas, or lower the pools you set.
- **Two releases side by side do not fit**: the process boots and logs `pool_budget_overlap_exceeded`. A rolling deploy may then run out of connections. Set `DB_CELL_STRICT=true` to refuse the boot instead.

With `DB_CELL_ENDPOINT=direct` (the default), the process also reads the database's own limit (`max_connections` minus its reserved slots) and applies the same rule to it. If the budget is above that limit, it logs `pool_budget_above_server_limit`.

## Behind PgBouncer

Set `DB_CELL_ENDPOINT=pooler` when `DATABASE_URL` points at PgBouncer or a similar pooler. The process then skips the server check, and its `pool_plan` line adds `perLogin`: the connections it opens per login (the request login and the privileged one). Size each login's `pool_size` in the pooler for those numbers times the replicas.

## Jobs wait for a slot

Some background work holds one jobs connection for its whole run: atomic app jobs, app event handlers, webhook retries and import batches. They take a slot before their transaction opens, first come first served, so more of them than the pool fits wait instead of failing. A worker's jobs pool keeps 2 connections for the other jobs, which never wait here; an api runs two event handlers at once. A job waiting over a minute logs `pinned_jobs_backlog`. A stopping process hands waiting jobs back to their queue. An event handler waits at most as long as the event bus waits for it (60 seconds); then it gives up and is logged as an event handler timeout.

## Read the pools on /diag

`/diag` (with `MONITOR_TOKEN`) shows:

- `pools`: for each pool, its `max`, the connections `held` now, the `peak`, how many callers are `waiting`, `acquireTimeouts`, and the `transactions` that got a connection since the process started;
- `poolPlan`: the plan this process booted with;
- `pinnedJobs`: the job slots' `max`, `held`, `peak`, `waiting` and the longest wait (`maxWaitMs`);
- `nestedPrivilegedAcquisitions`: privileged acquisitions made while the same call already held one. It should stay at 0.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `DB_CELL_MAX_CONNECTIONS` | unset (compose: `POSTGRES_MAX_CONNECTIONS`, 200) | The connection budget. Unset: no plan, no refusal. |
| `DB_CELL_RESERVED` | 15 | Connections kept outside the plan. |
| `DB_CELL_ENDPOINT` | `direct` | `direct` checks the server's limit; `pooler` logs per-login sums. |
| `DB_CELL_STRICT` | `false` | Refuse the boot when two releases side by side do not fit. |
| `LIAISON_API_REPLICAS` | 2 (compose: `API_REPLICAS`) | api processes in one release. |
| `LIAISON_WORKER_REPLICAS` | 1 (compose: `WORKER_REPLICAS`) | worker processes in one release. |
| `DB_POOL_MAX`, `DB_PRIVILEGED_POOL_MAX`, `DB_JOBS_POOL_MAX`, `DB_PRIVILEGED_JOBS_POOL_MAX` | planned | Fixed pool sizes that win over the plan. |
