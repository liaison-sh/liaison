// SPDX-License-Identifier: FSL-1.1-ALv2
//
// deploy/sandbox-firewall.sh `check` against a `docker` shim, and the compose
// file's sandbox defaults. The script must find the stack with the same inputs
// compose uses (-p, COMPOSE_PROJECT_NAME, --env-file, the .env beside the
// compose file), read its settings from the same place, and refuse to vouch
// for a network, an address or an image other than the ones its rules name.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const SCRIPT = path.join(import.meta.dir, "sandbox-firewall.sh")
const COMPOSE_FILE = path.join(import.meta.dir, "docker-compose.yml")

// The project compose would use: -p, else COMPOSE_PROJECT_NAME from the
// environment, else from the last --env-file (or the .env beside the compose
// file), else the compose file's directory name. Only the stack's project
// ("$SHIM_PROJECT") has containers.
const SHIM = `#!/bin/sh
S="$SHIM_STATE"
printf '%s\\n' "$*" >> "$S/calls.log"
if [ "$1" = compose ]; then
  shift
  project="" envfiles="" first=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -p) project="$2"; shift 2 ;;
      --env-file) envfiles="$envfiles $2"; shift 2 ;;
      -f) first="\${first:-$2}"; shift 2 ;;
      --profile) shift 2 ;;
      *) break ;;
    esac
  done
  [ -z "$envfiles" ] && [ -f "$(dirname "$first")/.env" ] && envfiles="$(dirname "$first")/.env"
  if [ -z "$project" ]; then project="\${COMPOSE_PROJECT_NAME:-}"; fi
  if [ -z "$project" ]; then
    for f in $envfiles; do
      v="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$f")"; [ -n "$v" ] && project="$v"
    done
  fi
  project="\${project:-$(basename "$(dirname "$first")")}"
  echo "$project" >> "$S/projects.log"
  [ "$project" = "$SHIM_PROJECT" ] || exit 0
  case "$1" in
    ps)
      shift
      for svc in "$@"; do case "$svc" in -*) ;; *) cat "$S/ps_$svc" 2>/dev/null || : ;; esac; done
      exit 0 ;;
    exec) shift; printf '%s\\n' "$@" >> "$S/exec.log"; exit 0 ;;
  esac
  exit 0
fi
case "$1 $2" in
  "network ls") cat "$S/networks" 2>/dev/null || :; exit 0 ;;
  "network inspect") cat "$S/net_$5"; exit 0 ;;
esac
if [ "$1" = inspect ]; then
  case "$3" in
    *IPAddress*) cat "$S/ip_$4" ;;
    *Image*) cat "$S/img_$4" ;;
  esac
  exit 0
fi
exit 0
`

let dir: string
let deployDir: string
let state: string
let bin: string

function put(name: string, value: string) {
  writeFileSync(path.join(state, name), value)
}

// A running stack: app (and an api process) and the sandbox service on the
// sandbox network, the network itself on the bridge device.
function stack(o: { subnet: string; sandboxIp: string; appIp: string; project?: string }) {
  put("project", o.project ?? "liaison")
  put("ps_app", "app1\n")
  put("ps_api", "")
  put("ps_worker", "")
  put("ps_sandbox", "sbx1\n")
  put("ip_app1", `172.20.0.5 ${o.appIp} `)
  put("ip_sbx1", `${o.sandboxIp} `)
  put("img_app1", "sha256:same")
  put("img_sbx1", "sha256:same")
  put("networks", "net1\n")
  put("net_net1", `liaison-sbx0 ${o.subnet} \n`)
}

function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["sh", path.join(deployDir, "sandbox-firewall.sh"), ...args], {
    cwd: dir,
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: dir,
      SHIM_STATE: state,
      SHIM_PROJECT: readFileSync(path.join(state, "project"), "utf8").trim(),
      ...env,
    },
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

function calls(): string {
  return readFileSync(path.join(state, "calls.log"), "utf8")
}

function exec(): string {
  return readFileSync(path.join(state, "exec.log"), "utf8")
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sandbox-firewall-test-"))
  deployDir = path.join(dir, "deploy")
  state = path.join(dir, "state")
  bin = path.join(dir, "bin")
  for (const d of [deployDir, state, bin]) mkdirSync(d)
  copyFileSync(SCRIPT, path.join(deployDir, "sandbox-firewall.sh"))
  writeFileSync(path.join(deployDir, "docker-compose.yml"), "services: {}\n")
  writeFileSync(path.join(bin, "docker"), SHIM)
  chmodSync(path.join(bin, "docker"), 0o755)
  writeFileSync(path.join(state, "calls.log"), "")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("sandbox-firewall.sh check finds the stack the way compose does", () => {
  it("with no option and the default project, it says how to name the stack instead of passing", () => {
    stack({ subnet: "10.73.250.0/24", sandboxIp: "10.73.250.10", appIp: "10.73.250.2" })
    const r = run(["check"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("no running sandbox service")
    expect(r.stderr).toContain("-p/--env-file/-f")
    expect(calls()).toContain(`compose -f ${path.join(deployDir, "docker-compose.yml")} ps -q sandbox`)
  })

  it("COMPOSE_PROJECT_NAME in the environment reaches compose", () => {
    stack({ subnet: "10.73.250.0/24", sandboxIp: "10.73.250.10", appIp: "10.73.250.2" })
    const r = run(["check"], { COMPOSE_PROJECT_NAME: "liaison" })
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("app processes on the sandbox network: 10.73.250.2")
    expect(exec()).toContain("APP_IPS=10.73.250.2 ")
    expect(exec()).toContain("'10.73.250.1', 22, 'blocked'")
    // Then each workerd process's own uid, unreadable by another.
    expect(exec()).toContain("workerd processes and their uids")
    expect(exec()).toContain("const other = 39999")
  })

  it("-p and --env-file are passed to compose, and the settings come from that env file", () => {
    stack({ subnet: "172.30.251.0/24", sandboxIp: "172.30.251.10", appIp: "172.30.251.3", project: "prod" })
    const envFile = path.join(dir, "custom.env")
    writeFileSync(
      envFile,
      'LIAISON_SANDBOX_SUBNET="172.30.251.0/24"\nLIAISON_SANDBOX_IP=172.30.251.10\nLIAISON_APP_BRIDGE_PORT=3100\n',
    )
    const r = run(["-p", "prod", "--env-file", envFile, "check"])
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    expect(calls()).toContain(`compose -p prod --env-file ${envFile} -f ${path.join(deployDir, "docker-compose.yml")}`)
    expect(r.stdout).toContain("sandbox at 172.30.251.10 on 172.30.251.0/24")
    expect(exec()).toContain("'172.30.251.1', 22, 'blocked'")
  })

  it("COMPOSE_PROJECT_NAME and the settings in the .env beside the compose file are used without any option", () => {
    stack({ subnet: "172.30.251.0/24", sandboxIp: "172.30.251.10", appIp: "172.30.251.3", project: "fromenv" })
    writeFileSync(
      path.join(deployDir, ".env"),
      "COMPOSE_PROJECT_NAME=fromenv\nLIAISON_SANDBOX_SUBNET=172.30.251.0/24\nLIAISON_SANDBOX_IP=172.30.251.10\n",
    )
    const r = run(["check"])
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("sandbox at 172.30.251.10 on 172.30.251.0/24")
  })

  it("the environment wins over the env file, as in compose", () => {
    stack({ subnet: "10.80.1.0/24", sandboxIp: "10.80.1.10", appIp: "10.80.1.4" })
    const envFile = path.join(dir, "custom.env")
    writeFileSync(envFile, "COMPOSE_PROJECT_NAME=liaison\nLIAISON_SANDBOX_SUBNET=172.30.251.0/24\n")
    const r = run(["--env-file", envFile, "check"], {
      LIAISON_SANDBOX_SUBNET: "10.80.1.0/24",
      LIAISON_SANDBOX_IP: "10.80.1.10",
    })
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
  })
})

describe("sandbox-firewall.sh refuses settings its rules would not match", () => {
  it("a live network on another subnet (an old install, or settings not passed)", () => {
    stack({ subnet: "172.31.250.0/24", sandboxIp: "172.31.250.10", appIp: "172.31.250.2" })
    const r = run(["check"], { COMPOSE_PROJECT_NAME: "liaison" })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("runs on 172.31.250.0/24 but the settings say 10.73.250.0/24")
  })

  it("apply stops on the same mismatch before touching any rule", () => {
    stack({ subnet: "172.31.250.0/24", sandboxIp: "172.31.250.10", appIp: "172.31.250.2" })
    writeFileSync(path.join(bin, "id"), "#!/bin/sh\necho 0\n")
    writeFileSync(path.join(bin, "iptables"), `#!/bin/sh\necho "$*" >> "${state}/iptables.log"\n`)
    chmodSync(path.join(bin, "id"), 0o755)
    chmodSync(path.join(bin, "iptables"), 0o755)
    const r = run(["apply"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("runs on 172.31.250.0/24")
    expect(() => readFileSync(path.join(state, "iptables.log"))).toThrow()
  })

  it("a sandbox service at another address than LIAISON_SANDBOX_IP", () => {
    stack({ subnet: "10.73.250.0/24", sandboxIp: "10.73.250.20", appIp: "10.73.250.2" })
    const r = run(["check"], { COMPOSE_PROJECT_NAME: "liaison" })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("the sandbox service is at '10.73.250.20', the rules name 10.73.250.10")
  })

  it("a sandbox service on another image than the app", () => {
    stack({ subnet: "10.73.250.0/24", sandboxIp: "10.73.250.10", appIp: "10.73.250.2" })
    put("img_sbx1", "sha256:older")
    const r = run(["check"], { COMPOSE_PROJECT_NAME: "liaison" })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("runs image sha256:older but app process app1 runs sha256:same")
  })

  it("an address outside the subnet, or a subnet that is not a /24", () => {
    stack({ subnet: "10.73.250.0/24", sandboxIp: "10.73.250.10", appIp: "10.73.250.2" })
    const outside = run(["check"], { LIAISON_SANDBOX_SUBNET: "10.9.9.0/24" })
    expect(outside.code).toBe(1)
    expect(outside.stderr).toContain("is not in LIAISON_SANDBOX_SUBNET (10.9.9.0/24): set both")
    const wide = run(["check"], { LIAISON_SANDBOX_SUBNET: "10.9.0.0/16" })
    expect(wide.code).toBe(1)
    expect(wide.stderr).toContain("must be a /24")
  })
})

describe("the compose file's sandbox defaults", () => {
  const raw = readFileSync(COMPOSE_FILE, "utf8")
  const compose = Bun.YAML.parse(raw) as {
    services: Record<string, { image?: string; networks?: Record<string, { ipv4_address?: string }> }>
    networks: Record<string, { ipam?: { config?: { subnet?: string }[] } }>
  }
  const script = readFileSync(SCRIPT, "utf8")
  const fallback = (expr: string | undefined) => expr?.match(/^\$\{[A-Z_]+:-(.+)\}$/)?.[1]

  it("the sandbox service runs exactly the app's image, through the same variable", () => {
    expect(compose.services.sandbox?.image).toBe(compose.services.app?.image)
    expect(compose.services.app?.image).toStartWith("${LIAISON_IMAGE:-")
    // One definition: an override of the anchor moves both.
    expect(raw).toMatch(/^ {4}image: &liaison-image \$\{LIAISON_IMAGE:-/m)
    expect(raw).toMatch(/^ {2}sandbox:\n(?: {4}#.*\n)* {4}image: \*liaison-image$/m)
  })

  it("subnet and address are the script's defaults, one inside the other", () => {
    const subnetExpr = compose.networks.sandbox?.ipam?.config?.[0]?.subnet
    const ipExpr = compose.services.sandbox?.networks?.sandbox?.ipv4_address
    expect(subnetExpr).toStartWith("${LIAISON_SANDBOX_SUBNET:-")
    expect(ipExpr).toStartWith("${LIAISON_SANDBOX_IP:-")
    const subnet = fallback(subnetExpr)
    const ip = fallback(ipExpr)
    expect(script).toContain(`SUBNET="$(setting LIAISON_SANDBOX_SUBNET ${subnet})"`)
    expect(script).toContain(`SANDBOX_IP="$(setting LIAISON_SANDBOX_IP ${ip})"`)
    expect(subnet).toMatch(/^\d+\.\d+\.\d+\.0\/24$/)
    expect(ip?.startsWith(subnet?.replace(/0\/24$/, "") ?? "?")).toBe(true)
  })

  it("the default subnet stays out of the ranges clouds and tools take by default", () => {
    const subnet = fallback(compose.networks.sandbox?.ipam?.config?.[0]?.subnet) ?? ""
    const toInt = (a: string) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0)
    const base = toInt(subnet.split("/")[0] ?? "")
    const taken = [
      "172.16.0.0/12", // AWS default VPC 172.31/16, Docker's own pools
      "192.168.0.0/16", // Docker pools, home and office LANs
      "10.0.0.0/15", // AWS/Azure/Hetzner wizard VPCs
      "10.42.0.0/15", // k3s
      "10.88.0.0/15", // Podman
      "10.96.0.0/12", // Kubernetes services
      "10.104.0.0/13", // DigitalOcean VPCs
      "10.128.0.0/9", // GCP auto mode, DigitalOcean
      "100.64.0.0/10", // CGNAT, Tailscale
    ]
    for (const cidr of taken) {
      const [net = "", bits = "0"] = cidr.split("/")
      const size = 2 ** (32 - Number(bits))
      const start = toInt(net)
      expect(base >= start && base < start + size, `${subnet} inside ${cidr}`).toBe(false)
    }
  })
})

// The boot unit. Rules in place before Docker starts any container, from a copy
// of the script on the root disk (the checkout may sit on a volume mounted after
// boot), never holding Docker back: Docker only wants the unit, so a missing
// script or a failed apply still lets it start (the service then refuses runs).
describe("sandbox-firewall.sh install writes a unit that runs before Docker", () => {
  let root: string

  // Root, iptables, modprobe, sysctl and systemctl stubs; /proc and /etc under a fake root.
  function host() {
    root = path.join(dir, "root")
    mkdirSync(path.join(root, "proc/sys/net/bridge"), { recursive: true })
    writeFileSync(path.join(root, "proc/sys/net/bridge/bridge-nf-call-iptables"), "1\n")
    mkdirSync(path.join(root, "etc/systemd/system/multi-user.target.wants"), { recursive: true })
    const stub = (name: string, body: string) => {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(path.join(bin, name), 0o755)
    }
    stub("id", "echo 0")
    stub("iptables", `echo "$*" >> "${state}/iptables.log"; case "$*" in *" -C "* | *" -D "*) exit 1 ;; esac; exit 0`)
    stub("modprobe", "exit 0")
    stub("sysctl", "exit 0")
    stub(
      "systemctl",
      `echo "$*" >> "${state}/systemctl.log"
case "$1" in
  enable) mkdir -p "${root}/etc/systemd/system/docker.service.wants"; ln -sf ../liaison-sandbox-firewall.service "${root}/etc/systemd/system/docker.service.wants/$2" ;;
  disable) rm -f "${root}/etc/systemd/system/"*.wants/"$2" ;;
esac
exit 0`,
    )
  }

  const unitPath = () => path.join(root, "etc/systemd/system/liaison-sandbox-firewall.service")
  const copyPath = () => path.join(root, "usr/local/lib/liaison/sandbox-firewall.sh")
  const log = (name: string) => {
    try {
      return readFileSync(path.join(state, name), "utf8")
    } catch {
      return ""
    }
  }

  it("orders the unit before docker.service, wanted by it, on a copy of the script outside the checkout", () => {
    stack({ subnet: "10.73.250.0/24", sandboxIp: "10.73.250.10", appIp: "10.73.250.2" })
    host()
    // An earlier install's link from multi-user.target.
    writeFileSync(path.join(root, "etc/systemd/system/multi-user.target.wants/liaison-sandbox-firewall.service"), "")
    const envFile = path.join(dir, "custom.env")
    writeFileSync(envFile, "LIAISON_SANDBOX_SUBNET=10.73.250.0/24\n")
    const r = run(["-p", "liaison", "--env-file", envFile, "install"], { SANDBOX_FIREWALL_ROOT: root })
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    const unit = readFileSync(unitPath(), "utf8")
    const lines = unit.split("\n")
    expect(lines).toContain("Before=docker.service")
    expect(lines.some((l) => l.startsWith("After=") && l.includes("network-pre.target"))).toBe(true)
    expect(lines).toContain("RequiresMountsFor=/usr/local/lib/liaison")
    expect(lines).toContain("WantedBy=docker.service")
    expect(lines.some((l) => l.startsWith("TimeoutStartSec="))).toBe(true)
    // Docker never depends on it, and it never waits for Docker.
    expect(unit).not.toMatch(/^(Wants|Requires|BindsTo|PartOf|RequiredBy|After)=.*docker/m)
    expect(unit).not.toContain("multi-user.target")
    expect(unit).not.toMatch(/^DefaultDependencies=no/m)
    // The root-disk copy, no compose option (its files may not be mounted yet).
    expect(lines).toContain("ExecStart=/bin/sh /usr/local/lib/liaison/sandbox-firewall.sh apply --boot")
    expect(unit).not.toContain(dir)
    expect(lines).toContain("Environment=LIAISON_SANDBOX_SUBNET=10.73.250.0/24")
    expect(lines).toContain("Environment=LIAISON_SANDBOX_IP=10.73.250.10")
    expect(readFileSync(copyPath(), "utf8")).toBe(readFileSync(SCRIPT, "utf8"))
    // The old link is gone, the new one in place, disabled before enabled.
    expect(() => readFileSync(path.join(root, "etc/systemd/system/multi-user.target.wants/liaison-sandbox-firewall.service"))).toThrow()
    const sc = log("systemctl.log")
    expect(sc.indexOf("disable liaison-sandbox-firewall.service")).toBeGreaterThanOrEqual(0)
    expect(sc.indexOf("disable")).toBeLessThan(sc.indexOf("enable liaison-sandbox-firewall.service"))
    // The rules were applied now too.
    expect(log("iptables.log")).toContain("-A LIAISON-SANDBOX-FWD -i liaison-sbx0 -j DROP")
  })

  it("a second install gives the same unit and copy", () => {
    stack({ subnet: "10.73.250.0/24", sandboxIp: "10.73.250.10", appIp: "10.73.250.2" })
    host()
    expect(run(["install"], { SANDBOX_FIREWALL_ROOT: root }).code).toBe(0)
    const first = readFileSync(unitPath(), "utf8")
    const again = run(["install"], { SANDBOX_FIREWALL_ROOT: root })
    expect(again.stderr).toBe("")
    expect(again.code).toBe(0)
    expect(readFileSync(unitPath(), "utf8")).toBe(first)
    expect(readFileSync(copyPath(), "utf8")).toBe(readFileSync(SCRIPT, "utf8"))
  })

  it("apply --boot never calls Docker: a hung daemon does not hold the boot", () => {
    stack({ subnet: "10.73.250.0/24", sandboxIp: "10.73.250.10", appIp: "10.73.250.2" })
    host()
    writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "$*" >> "${state}/docker-calls.log"\nsleep 30\n`)
    const started = Date.now()
    const r = run(["apply", "--boot"], { SANDBOX_FIREWALL_ROOT: root })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    expect(log("docker-calls.log")).toBe("")
    const ipt = log("iptables.log")
    expect(ipt).toContain("-N DOCKER-USER")
    expect(ipt).toContain("-A LIAISON-SANDBOX-IN -s 10.73.250.10 -j DROP")
    expect(ipt).toContain("-A LIAISON-SANDBOX-FWD -i liaison-sbx0 -j DROP")
  })

  it("the root-disk copy applies alone, from the unit's settings, with no compose file beside it", () => {
    host()
    const lib = path.join(dir, "lib")
    mkdirSync(lib)
    copyFileSync(SCRIPT, path.join(lib, "sandbox-firewall.sh"))
    writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "$*" >> "${state}/docker-calls.log"\nexit 1\n`)
    const proc = Bun.spawnSync(["/bin/sh", path.join(lib, "sandbox-firewall.sh"), "apply", "--boot"], {
      cwd: "/",
      env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        SANDBOX_FIREWALL_ROOT: root,
        LIAISON_SANDBOX_SUBNET: "10.80.1.0/24",
        LIAISON_SANDBOX_IP: "10.80.1.10",
        LIAISON_SANDBOX_BRIDGE: "liaison-sbx0",
        LIAISON_APP_BRIDGE_PORT: "3100",
      },
    })
    expect(proc.stderr.toString()).toBe("")
    expect(proc.exitCode).toBe(0)
    expect(log("docker-calls.log")).toBe("")
    expect(log("iptables.log")).toContain("-A LIAISON-SANDBOX-IN -s 10.80.1.10 -j DROP")
  })

  it("apply without --boot still refuses a live network on other settings; an unknown flag is refused", () => {
    stack({ subnet: "172.31.250.0/24", sandboxIp: "172.31.250.10", appIp: "172.31.250.2" })
    host()
    const r = run(["apply"], { SANDBOX_FIREWALL_ROOT: root })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("runs on 172.31.250.0/24")
    const bad = run(["apply", "--now"], { SANDBOX_FIREWALL_ROOT: root })
    expect(bad.code).toBe(2)
    expect(log("iptables.log")).toBe("")
  })

  it("remove drops the unit, the copy and every link", () => {
    stack({ subnet: "10.73.250.0/24", sandboxIp: "10.73.250.10", appIp: "10.73.250.2" })
    host()
    expect(run(["install"], { SANDBOX_FIREWALL_ROOT: root }).code).toBe(0)
    writeFileSync(path.join(root, "etc/systemd/system/multi-user.target.wants/liaison-sandbox-firewall.service"), "")
    const r = run(["remove"], { SANDBOX_FIREWALL_ROOT: root })
    expect(r.code).toBe(0)
    expect(() => readFileSync(unitPath())).toThrow()
    expect(() => readFileSync(copyPath())).toThrow()
    for (const wants of ["multi-user.target.wants", "docker.service.wants"]) {
      expect(() => readFileSync(path.join(root, "etc/systemd/system", wants, "liaison-sandbox-firewall.service"))).toThrow()
    }
    expect(log("systemctl.log")).toContain("daemon-reload")
  })
})
