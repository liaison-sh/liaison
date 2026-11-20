// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The render service's isolation as the stack declares it: the parser of an uploaded
// file runs in a service with no network, no secret, no data volume and its own user.
// This reads the compose file and the check script that probes the running service;
// the probes themselves run against the composed service on a labelled box
// (deploy/pdf-render-check.sh), never here.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const DEPLOY = resolve(import.meta.dir, "../../../../../../deploy")

interface Service {
  network_mode?: string
  networks?: unknown
  ports?: unknown[]
  user?: string
  read_only?: boolean
  cap_drop?: string[]
  security_opt?: string[]
  env_file?: unknown
  environment?: Record<string, string>
  volumes?: string[]
  pids_limit?: number
  mem_limit?: string
}

function service(name: string): Service {
  const compose = Bun.YAML.parse(readFileSync(resolve(DEPLOY, "docker-compose.yml"), "utf8")) as {
    services: Record<string, Service>
  }
  const s = compose.services[name]
  if (!s) throw new Error(`no service ${name}`)
  return s
}

describe("the render service's isolation", () => {
  it("NT-63: the service has no network, no port, no env file, no secret, no data volume, its own user and nothing writable", () => {
    const render = service("pdf-render")
    expect(render.network_mode).toBe("none")
    expect(render.networks).toBeUndefined()
    expect(render.ports ?? []).toEqual([])
    expect(render.env_file).toBeUndefined()
    expect(Object.keys(render.environment ?? {}).sort()).toEqual([
      "LIAISON_PDF_RENDER_SOCKET",
      "NODE_ENV",
    ])
    expect(render.read_only).toBe(true)
    expect(render.cap_drop).toEqual(["ALL"])
    expect(render.security_opt).toContain("no-new-privileges:true")
    expect(render.pids_limit).toBeGreaterThan(0)
    expect(render.mem_limit).toBeTruthy()
    // One volume, the socket's: no data, uploads, key or env volume.
    expect(render.volumes).toEqual(["pdf-render-socket:/run/pdf-render"])
    // Its UID is neither root nor the app's.
    const uid = Number((render.user ?? "").split(":")[0])
    expect(uid).toBeGreaterThan(1000)
    for (const other of ["app", "worker"]) {
      const user = service(other).user
      if (user) expect(user.split(":")[0]).not.toBe(String(uid))
    }
  })

  it("NT-63: the stack's check probes the connections, the processes, the writes, the secrets and both crafted files", () => {
    const script = readFileSync(resolve(DEPLOY, "pdf-render-check.sh"), "utf8")
    for (const probe of [
      '"postgres", "postgres", 5432',
      '"redis", "redis", 6379',
      '"internet", "1.1.1.1", 443',
      "the API process is not visible",
      "no other process environment is readable",
      "/app/.render-probe",
      "the environment holds no secret",
      "runs as its own user",
      "an inflate bomb is refused",
      "a cross-reference cycle is refused",
    ]) {
      expect(script, probe).toContain(probe)
    }
  })

  it("NT-63: the render service is not started with the app's env file or reached by the app over a network", () => {
    const app = service("app")
    // The app talks to it over the socket volume only.
    expect(app.environment?.LIAISON_PDF_RENDER_SOCKET).toContain("/run/pdf-render/render.sock")
    expect((app.volumes ?? []).some((v) => v.startsWith("pdf-render-socket:"))).toBe(true)
  })
})
