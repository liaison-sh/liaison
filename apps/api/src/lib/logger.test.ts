// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { DrizzleQueryError } from "drizzle-orm/errors"
import pino from "pino"
import { LOG_SERIALIZERS, REDACT_PATHS } from "~/lib/logger"

/**
 * Capture the serialized output of a pino logger configured with the real
 * `REDACT_PATHS`. We construct a fresh instance over an in-memory sink rather
 * than scraping `rootLogger` so the assertion is deterministic and isolated
 * from the live transport, while still exercising the exact configured policy.
 */
function captureLog(payload: Record<string, unknown>): string {
  const lines: string[] = []
  const sink = {
    write(chunk: string) {
      lines.push(chunk)
    },
  }
  const log = pino({ redact: REDACT_PATHS }, sink)
  log.info(payload, "test message")
  return lines.join("")
}

describe("logger redact policy", () => {
  test("redacts a field named secret, at the top level and nested", () => {
    const out = captureLog({ secret: "card-secret-top", form: { secret: "card-secret-nested" } })
    expect(out).not.toContain("card-secret-top")
    expect(out).not.toContain("card-secret-nested")
  })

  test("redacts each provisioning secret at the top level", () => {
    const out = captureLog({
      apiKey: "sk-secret-apikey",
      apiToken: "tok-secret-apitoken",
      credentials: { password: "imap-pass", token: "imap-tok" },
      byok: { anthropic: { apiKey: "sk-ant-byok" } },
      providerKeys: { anthropic: { encrypted: "enc-secret" } },
    })

    const parsed = JSON.parse(out)
    expect(parsed.apiKey).toBe("[Redacted]")
    expect(parsed.apiToken).toBe("[Redacted]")
    expect(parsed.credentials).toBe("[Redacted]")
    expect(parsed.byok).toBe("[Redacted]")
    expect(parsed.providerKeys).toBe("[Redacted]")

    // No secret substring survives anywhere in the serialized line.
    for (const secret of [
      "sk-secret-apikey",
      "tok-secret-apitoken",
      "imap-pass",
      "imap-tok",
      "sk-ant-byok",
      "enc-secret",
    ]) {
      expect(out).not.toContain(secret)
    }
  })

  test("redacts nested secrets via the *. wildcard variant", () => {
    const out = captureLog({
      context: {
        apiKey: "nested-apikey-secret",
        apiToken: "nested-apitoken-secret",
        credentials: { password: "nested-pass" },
        byok: { openai: { apiKey: "nested-byok" } },
        providerKeys: { openai: { encrypted: "nested-enc" } },
      },
    })

    const parsed = JSON.parse(out)
    expect(parsed.context.apiKey).toBe("[Redacted]")
    expect(parsed.context.apiToken).toBe("[Redacted]")
    expect(parsed.context.credentials).toBe("[Redacted]")
    expect(parsed.context.byok).toBe("[Redacted]")
    expect(parsed.context.providerKeys).toBe("[Redacted]")

    for (const secret of [
      "nested-apikey-secret",
      "nested-apitoken-secret",
      "nested-pass",
      "nested-byok",
      "nested-enc",
    ]) {
      expect(out).not.toContain(secret)
    }
  })

  test("preserves the existing redact entries (regression guard)", () => {
    // The new CLI entries must be additive — existing protections still hold.
    for (const path of ["password", "clientSecret", "refreshToken", "accessToken", "token"]) {
      expect(REDACT_PATHS).toContain(path)
      expect(REDACT_PATHS).toContain(`*.${path}`)
    }
    for (const path of ["apiKey", "apiToken", "credentials", "byok", "providerKeys"]) {
      expect(REDACT_PATHS).toContain(path)
      expect(REDACT_PATHS).toContain(`*.${path}`)
    }
  })
})

// The wrapped shells present their refresh token in a HEADER, not in the
// cookie: `X-Liaison-Refresh` carries a live 30 day credential, exactly like
// `cookie` and `authorization` beside it. A request log that captured headers
// wrote it out in full.
describe("logger redact policy: the shell refresh header", () => {
  test("redacts x-liaison-refresh wherever request headers are logged", () => {
    const out = captureLog({
      req: { headers: { "x-liaison-refresh": "rt-live-credential", cookie: "liaison_rt=c" } },
      context: { headers: { "x-liaison-refresh": "rt-nested-credential" } },
    })

    const parsed = JSON.parse(out)
    expect(parsed.req.headers["x-liaison-refresh"]).toBe("[Redacted]")
    expect(parsed.context.headers["x-liaison-refresh"]).toBe("[Redacted]")
    expect(out).not.toContain("rt-live-credential")
    expect(out).not.toContain("rt-nested-credential")
  })

  test("keeps the header paths listed beside the cookie ones", () => {
    for (const path of ["req.headers", "*.headers"]) {
      expect(REDACT_PATHS).toContain(`${path}.cookie`)
      expect(REDACT_PATHS).toContain(`${path}["x-liaison-refresh"]`)
    }
  })
})

/**
 * A query error is diagnosable only by the database's own answer. drizzle wraps
 * it as the `cause` of a DrizzleQueryError whose own message is the query and
 * its parameters; pino's default serializer folds the cause's text onto the end
 * of the parameter list and drops its SQLSTATE, so a job error read in the logs
 * said what was run and not why it failed.
 */
describe("logger error serializer", () => {
  function captureError(err: unknown): Record<string, unknown> {
    const lines: string[] = []
    const log = pino(
      { redact: REDACT_PATHS, serializers: LOG_SERIALIZERS },
      {
        write(chunk: string) {
          lines.push(chunk)
        },
      },
    )
    log.error({ err }, "Job handler error")
    return JSON.parse(lines.join("")).err as Record<string, unknown>
  }

  test("a query error carries the database error's message and SQLSTATE as its own fields", () => {
    const pgError = Object.assign(new Error("function similarity(text, boolean) does not exist"), {
      name: "PostgresError",
      code: "42883",
      severity: "ERROR",
      hint: "No function matches the given name and argument types.",
      position: "171",
      routine: "ParseFuncOrColumn",
    })
    const err = captureError(
      new DrizzleQueryError("SELECT similarity(description, $1)", [true], pgError),
    )
    expect(err.type).toBe("DrizzleQueryError")
    const cause = err.cause as Record<string, unknown>
    expect(cause.message).toBe("function similarity(text, boolean) does not exist")
    expect(cause.sqlstate).toBe("42883")
    expect(cause.severity).toBe("ERROR")
    expect(cause.hint).toBe("No function matches the given name and argument types.")
    expect(cause.routine).toBe("ParseFuncOrColumn")
  })

  test("a plain error without a cause serializes as before", () => {
    const err = captureError(new Error("boom"))
    expect(err.message).toBe("boom")
    expect(err.cause).toBeUndefined()
  })

  test("a cause chain is followed, and a cycle does not loop", () => {
    const inner = new Error("inner")
    const outer = new Error("outer", { cause: inner })
    ;(inner as Error & { cause?: unknown }).cause = outer
    const err = captureError(outer)
    const cause = err.cause as Record<string, unknown>
    expect(cause.message).toBe("inner")
  })
})
