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

Then `docker compose up -d` from `deploy/`. Every app process gets a second listener on port 3100 (`LIAISON_APP_BRIDGE_PORT`) that answers `/api/app-bridge/<run>` and nothing else, and joins the sandbox network. The service sends each run's `ctx.*` calls back to the process that sent the run, at the address the run came from (under gVisor the sandbox cannot use Docker's name service, so no name or fixed address is involved). This works the same for the single `app` container and for the rolling `api` and `worker` processes of `deploy/rolling-deploy.sh`, old and new side by side. Each sandboxed app whose installed version carries a Worker module (`worker.js`, every bundled app does) runs on the service; its timing lines say `executor: "workerd"` and its usage rows count under `workerd`, with the CPU time the service measured for each run.

The app's `/healthz` shows the service as the `sandbox` dependency: `ok` when it answers with the app's release and can reach that process's bridge listener, `release_mismatch` or `bridge_unreachable` otherwise.

To go back for a while, set `LIAISON_APP_RUNTIME=quickjs` and restart the app: every app runs on the local sandbox again, whatever else is set. This switch exists in this release only.

## Upgrades

The service runs the same image as the app and must run the same release. Every request the app sends it names the app's release; a service of another release refuses the run (`sandbox_release_mismatch`, with the command to fix it), its container health check turns unhealthy, and the app's `/healthz` reports `release_mismatch`. So after an upgrade the service is recreated with the app:

- Single `app` container: keep `COMPOSE_PROFILES=sandbox` in `deploy/.env` and run `docker compose up -d` (or `docker compose up -d app`: the app depends on the service, so it is recreated too when its image moved).
- Rolling deploys: `deploy/rolling-deploy.sh` recreates the service on the new image as soon as the new `api` and `worker` processes are ready, before the old ones drain. Sandboxed runs still started by the old processes are refused from then on.
- By hand: `docker compose --profile sandbox up -d sandbox`.

The compose file gives the service exactly the app's image: both read `LIAISON_IMAGE`, through one definition. To pull from your own registry (Amazon ECR, a private registry), set `LIAISON_IMAGE` to that image, for example `LIAISON_IMAGE=<account>.dkr.ecr.<region>.amazonaws.com/liaison:v0.3.0`: the app, the service and the rolling `api`, `worker` and `migrate` processes all follow. Do not set `image:` on `app` alone in an override file; if you must, set the same value on `sandbox` too. `deploy/sandbox-firewall.sh check` fails when the service and an app process run different images.

## Install the firewall step

A Docker network marked `internal` has no route out, but its containers still reach the host on the network's gateway address (an SSH server, anything bound to `0.0.0.0`) and every port of the other containers on it, the app's main port included. The firewall step closes that: from the sandbox service only the app's bridge port answers.

```sh
sudo deploy/sandbox-firewall.sh install   # rules now, and a systemd unit for every boot
deploy/sandbox-firewall.sh check          # from inside the sandbox: only the bridge port answers
```

`check` prints one line per probe for every running app process on the sandbox network (`app`, or the rolling `api` and `worker` processes: each one's bridge port must answer and its main port must be blocked; the host's SSH port, the cloud metadata address and a public address must be blocked too) and exits non-zero on any miss. `sudo deploy/sandbox-firewall.sh remove` takes the rules away.

The script finds the stack and its settings the way `docker compose` does, so give it the same options you give compose, before the command:

```sh
sudo deploy/sandbox-firewall.sh -p liaison --env-file /srv/liaison/liaison.env install
deploy/sandbox-firewall.sh -p liaison --env-file /srv/liaison/liaison.env check
```

It accepts `-p`/`--project-name`, `--env-file` (several allowed) and `-f`/`--file` (default `deploy/docker-compose.yml`), and honours `COMPOSE_PROJECT_NAME` from the environment or the env file. Without `--env-file` it reads `deploy/.env`, as compose does. The settings it reads (environment first, then the env files) are the compose file's: `LIAISON_SANDBOX_SUBNET`, `LIAISON_SANDBOX_IP`, `LIAISON_SANDBOX_BRIDGE` (liaison-sbx0) and `LIAISON_APP_BRIDGE_PORT` (3100). `install` writes the options and values into the systemd unit.

On the sandbox network the rules let through only an app process's connection to the service and the service's connection to an app process's bridge port; anything else coming from that network is dropped. `apply` and `check` stop with an error when the live network's subnet, or the service's address, is not the one in the settings.

## Network address

The sandbox network is a /24 with the service at a fixed address in it, both set in `deploy/.env`:

```sh
LIAISON_SANDBOX_SUBNET=10.73.250.0/24
LIAISON_SANDBOX_IP=10.73.250.10
```

Those are the defaults. They avoid the ranges clouds and tools use by default: AWS's default VPC (172.31.0.0/16) and Docker's own address pools (172.17.0.0/16 to 172.31.0.0/16, 192.168.0.0/16), the VPCs AWS, Azure and Hetzner propose (10.0.0.0/16, 10.1.0.0/16), Google Cloud's auto mode (10.128.0.0/9), DigitalOcean's VPCs, Kubernetes, k3s and Podman networks, and Tailscale (100.64.0.0/10). If your host or its VPC already uses 10.73.250.0/24, pick another free /24 and set both values: compose and the firewall script read the same two names. The address must be inside the subnet.

### An install that ran the sandbox before this change

Earlier versions put the network on 172.31.250.0/24, with the service at 172.31.250.10. Docker recreates the network when its subnet changes, so upgrading without a setting would move it while the firewall unit still names the old address. To keep the network where it is, pin the old values in `deploy/.env` before you upgrade:

```sh
LIAISON_SANDBOX_SUBNET=172.31.250.0/24
LIAISON_SANDBOX_IP=172.31.250.10
```

To move to the new default (required on a host inside an AWS default VPC, where 172.31.250.0/24 collides), set the new values, then `docker compose up -d`, then `sudo deploy/sandbox-firewall.sh install` again (with your `-p`/`--env-file`) so the unit names the new network, and `deploy/sandbox-firewall.sh check`. Until the firewall step is reinstalled, the rules drop the network's traffic and sandboxed runs fail; `LIAISON_APP_RUNTIME=quickjs` keeps apps running meanwhile.

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
