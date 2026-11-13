// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { assertComposeRoleSeparation, roleFromPgUrl, sandboxDrillEnv } from "./validate-compose"

const ROOT = resolve(import.meta.dir, "..")
const COMPOSE = readFileSync(join(ROOT, "deploy/docker-compose.yml"), "utf8")

describe("roleFromPgUrl", () => {
  it("extracts the login role from a connection string", () => {
    expect(roleFromPgUrl("postgres://liaison_app:secret@postgres:5432/liaison")).toBe("liaison_app")
    expect(roleFromPgUrl("postgresql://liaison:pw@host/db")).toBe("liaison")
    // Compose ${VAR} interpolation in the password position must not confuse it.
    expect(
      roleFromPgUrl("postgres://liaison_app:${LIAISON_APP_PASSWORD}@postgres:5432/liaison"),
    ).toBe("liaison_app")
  })

  it("returns null for non-postgres / unparseable URLs", () => {
    expect(roleFromPgUrl(undefined)).toBeNull()
    expect(roleFromPgUrl("redis://redis:6379")).toBeNull()
    expect(roleFromPgUrl("")).toBeNull()
  })
})

describe("assertComposeRoleSeparation — committed compose", () => {
  it("passes for the production compose file", () => {
    expect(() => assertComposeRoleSeparation(COMPOSE)).not.toThrow()
  })
})

describe("assertComposeRoleSeparation — guards", () => {
  const base = `
name: liaison
services:
  postgres:
    image: postgres:17-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./postgres-init:/docker-entrypoint-initdb.d:ro
  app:
    image: liaison
    environment:
      DATABASE_URL: postgres://liaison_app:\${LIAISON_APP_PASSWORD}@postgres:5432/liaison
      MIGRATION_DATABASE_URL: postgres://liaison:\${POSTGRES_PASSWORD}@postgres:5432/liaison
`

  it("accepts the canonical role split", () => {
    expect(() => assertComposeRoleSeparation(base)).not.toThrow()
  })

  it("rejects a superuser runtime DATABASE_URL (postgres)", () => {
    const bad = base.replace(
      "postgres://liaison_app:${LIAISON_APP_PASSWORD}@postgres:5432/liaison",
      "postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/liaison",
    )
    expect(() => assertComposeRoleSeparation(bad)).toThrow(/privileged role "postgres"/)
  })

  it("rejects the bootstrap owner role (liaison) as the runtime connection", () => {
    const bad = base.replace(
      "postgres://liaison_app:${LIAISON_APP_PASSWORD}@postgres:5432/liaison",
      "postgres://liaison:${POSTGRES_PASSWORD}@postgres:5432/liaison",
    )
    expect(() => assertComposeRoleSeparation(bad)).toThrow(/privileged role "liaison"/)
  })

  it("rejects a missing MIGRATION_DATABASE_URL", () => {
    const bad = base
      .split("\n")
      .filter((l) => !l.includes("MIGRATION_DATABASE_URL"))
      .join("\n")
    expect(() => assertComposeRoleSeparation(bad)).toThrow(/MIGRATION_DATABASE_URL/)
  })

  it("rejects migrations sharing the runtime role", () => {
    const bad = base.replace(
      "postgres://liaison:${POSTGRES_PASSWORD}@postgres:5432/liaison",
      "postgres://liaison_app:${LIAISON_APP_PASSWORD}@postgres:5432/liaison",
    )
    expect(() => assertComposeRoleSeparation(bad)).toThrow(/distinct from the runtime app role/)
  })

  it("rejects a postgres service that does not mount the role-init hook", () => {
    const bad = base
      .split("\n")
      .filter((l) => !l.includes("/docker-entrypoint-initdb.d"))
      .join("\n")
    expect(() => assertComposeRoleSeparation(bad)).toThrow(/docker-entrypoint-initdb\.d/)
  })
})

describe("sandboxDrillEnv", () => {
  it("runs the sandbox service on runc, accepted explicitly, on a host without gVisor", () => {
    expect(sandboxDrillEnv(["io.containerd.runc.v2", "runc"], {})).toEqual({
      LIAISON_SANDBOX_RUNTIME: "runc",
      LIAISON_SANDBOX_ALLOW_NO_GVISOR: "1",
      LIAISON_SANDBOX_ALLOW_OPEN_NETWORK: "1",
    })
  })

  it("keeps the compose default (gVisor) where the host has it", () => {
    expect(sandboxDrillEnv(["runc", "runsc"], {})).toEqual({})
  })

  it("never overrides a runtime the caller chose", () => {
    expect(sandboxDrillEnv(["runc"], { LIAISON_SANDBOX_RUNTIME: "runsc" })).toEqual({})
  })
})

describe("compose: the sandbox service is part of every stack", () => {
  it("has no profile and the app points at it by default", () => {
    const sandbox = COMPOSE.slice(COMPOSE.indexOf("\n  sandbox:\n"))
    const block = sandbox.slice(0, sandbox.indexOf("\n  # ----"))
    expect(block).toContain('command: ["sandbox"]')
    expect(block).not.toContain("profiles:")
    expect(COMPOSE).toContain("LIAISON_SANDBOX_URL: ${LIAISON_SANDBOX_URL:-http://sandbox:8790}")
  })
})
