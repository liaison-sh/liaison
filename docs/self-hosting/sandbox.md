---
title: The app sandbox service
description: Run sandboxed apps on workerd under gVisor on your own server - install gVisor, turn the service on, install the firewall step, size it, and the risks it does not remove.
---

Apps that are not part of Liaison's core (the bundled apps, apps you install, your organizations' own apps) run in a sandbox. On a self-hosted server that sandbox can be the **sandbox service**: a supervised pool of `workerd` processes (the runtime behind Cloudflare Workers) in its own container, under gVisor, on a network that reaches nothing but one port of the app. In this release it is optional; without it apps run on the local QuickJS sandbox, as before.

What the service does for each run:

- One process serves one organization's app at one version at a time, and is never reused for another organization. It is replaced after 100 runs or 2 idle minutes.
- A run past its time is killed (its deadline plus 1 second), as is a run past its CPU time (read from the process) or a process past its memory cap (`SANDBOX_RSS_CAP_MB`, with a V8 heap of `SANDBOX_HEAP_MB`). Other organizations' runs go on.
- Nested runs (an app calling another app, a PDF render inside a tool) get processes kept for them, at most 4 deep, so a chain never waits on itself.
- A run holds no key and no secret: it gets a token for that run only, and every `ctx.*` call goes back to the app, which checks the token.

## Install gVisor

The service declares `runtime: runsc`, so Docker refuses to start it on a host without gVisor. gVisor needs no KVM (the default `systrap` platform works on any cloud VM). On Debian or Ubuntu:

```sh
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install
sudo systemctl reload docker
```

Check it: `docker run --rm --runtime=runsc busybox dmesg` prints gVisor's boot lines.

## Turn it on

In `deploy/.env`:

```sh
COMPOSE_PROFILES=sandbox
LIAISON_SANDBOX_URL=http://sandbox:8790
```

Then `docker compose up -d` from `deploy/`. The app gets a second listener on port 3100 (`LIAISON_APP_BRIDGE_PORT`) that answers `/api/app-bridge/<run>` and nothing else; the sandbox network reaches the app under the name `app-bridge`. Each sandboxed app whose installed version carries a Worker module (`worker.js`, every bundled app does) runs on the service; its timing lines say `executor: "workerd"` and its usage rows count under `workerd`.

To go back for a while, set `LIAISON_APP_RUNTIME=quickjs` and restart the app: every app runs on the local sandbox again, whatever else is set. This switch exists in this release only.

The service runs the same image as the app. After an upgrade, recreate it with the app (`docker compose up -d` does both), so both run the same release.

## Install the firewall step

A Docker network marked `internal` has no route out, but its containers still reach the host on the network's gateway address (an SSH server, anything bound to `0.0.0.0`) and every port of the other containers on it, the app's main port included. The firewall step closes that: from the sandbox service only the app's bridge port answers.

```sh
sudo deploy/sandbox-firewall.sh install   # rules now, and a systemd unit for every boot
deploy/sandbox-firewall.sh check          # from inside the sandbox: only the bridge port answers
```

`check` prints one line per probe (the app's bridge port must answer; the app's main port, the host's SSH port, the cloud metadata address and a public address must be blocked) and exits non-zero on any miss. `sudo deploy/sandbox-firewall.sh remove` takes the rules away. The script reads the compose file's defaults (`LIAISON_SANDBOX_IP` 172.31.250.10, `LIAISON_SANDBOX_SUBNET` 172.31.250.0/24, `LIAISON_SANDBOX_BRIDGE` liaison-sbx0, `LIAISON_APP_BRIDGE_PORT` 3100); change them in both places together.

## Size it

The worst case is every process at its memory cap: (`SANDBOX_POOL_SIZE` + `SANDBOX_POOL_OVERFLOW`) x `SANDBOX_RSS_CAP_MB`. Measured use is far below it (about 130 MiB for six loaded processes).

| Memory for the sandbox | Settings |
|---|---|
| 2 GiB (the defaults) | `SANDBOX_POOL_SIZE=6` (2 of them kept for nested runs), `SANDBOX_POOL_OVERFLOW=2`, `LIAISON_SANDBOX_MEM_LIMIT=2g`, `LIAISON_SANDBOX_CPUS=2.0` |
| 3 GiB | `SANDBOX_POOL_SIZE=10`, `SANDBOX_POOL_OVERFLOW=2`, `LIAISON_SANDBOX_MEM_LIMIT=3g`, `LIAISON_SANDBOX_CPUS=3.0` |

`SANDBOX_RSS_CAP_MB` (256) and `SANDBOX_HEAP_MB` (128) set one process's cap; `SANDBOX_RECYCLE_RUNS` (100) and `SANDBOX_IDLE_MS` (120000) when a process is replaced.

## A host without gVisor

Not recommended: tenants' code is then separated from the host's kernel by a container only. If you must, set both:

```sh
LIAISON_SANDBOX_RUNTIME=runc
LIAISON_SANDBOX_ALLOW_NO_GVISOR=1
```

The service refuses to start with the first alone, and with both it logs a warning at start and every hour.

## Risks it does not remove

- **Tenants share a host.** Every organization on the server runs its apps on the same machine. gVisor and workerd isolate them; they do not make them separate machines.
- **No Spectre guard.** gVisor does not mitigate Spectre-class side channels, and workerd's own mitigations assume Cloudflare's process isolation model.
- **Timers.** `Date.now()` is live (not frozen between I/O as on Cloudflare) and `performance.now()` has 1 ms resolution.
- **SharedArrayBuffer exists.** With live clocks it allows building finer timers.

## Development and CI

No container: the same supervisor and the same pinned `workerd` binary run directly (`bun run packages/sandbox-supervisor/src/main.ts` with `SANDBOX_BRIDGE_ORIGIN` set), and the tests start it in process. There is no setting that turns the sandbox off.
