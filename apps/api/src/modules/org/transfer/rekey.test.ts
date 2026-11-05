// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The move's key handling, without a database:
//   - `cli/keys-rotate.ts` is the file the owner approved, unchanged (git blob
//     pinned): the transfer only calls its exports;
//   - every encrypted column and JSON place keys-rotate knows is re-keyed on
//     export, both families, and a value the instance key cannot open refuses;
//   - the transfer keys are two 64-hex values, nothing else is accepted;
//   - every use of JWT_SECRET in the server is listed with what a move does to
//     it (JWT_SECRET stays per instance); a new use fails until it is answered.
import { describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { COLUMNS, JSON_COLUMNS } from "~/cli/keys-rotate"
import { CryptoContext, decryptSecret, encryptSecret, mailboxServerKeyContext } from "~/lib/crypto"
import { generateTransferKeys, parseTransferKeys, RekeyRefused, rekeyRowForExport } from "./rekey"

const SRC = path.resolve(import.meta.dir, "../../..")

/** The blob of `cli/keys-rotate.ts` the owner approved the move against (gate G-P4-1). */
const KEYS_ROTATE_BLOB = "f31e7ba80d1bd3e3e1099833c22852ae5b47b60d"

function gitBlobSha(file: string): string {
  const body = readFileSync(file)
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex")
}

describe("org transfer keys", () => {
  it("keys-rotate.ts is the approved file, unchanged", () => {
    expect(gitBlobSha(path.join(SRC, "cli/keys-rotate.ts"))).toBe(KEYS_ROTATE_BLOB)
  })

  it("re-keys every column and JSON place of both families to the transfer keys", () => {
    const own = {
      encryption: randomBytes(32).toString("hex"),
      byok: randomBytes(32).toString("hex"),
    }
    const transfer = generateTransferKeys()
    const tally = { encryption: 0, byok: 0 }
    for (const col of COLUMNS) {
      const row: Record<string, unknown> = { org_id: "o", account_id: "a", key_version: 3 }
      const ctx = col.rowContext ? mailboxServerKeyContext("o", "a", 3) : col.context
      row[col.column] = encryptSecret(`v-${col.column}`, own[col.family], ctx)
      rekeyRowForExport(`${col.schema}.${col.table}`, row, own, transfer, tally)
      expect(decryptSecret(row[col.column] as string, transfer[col.family], ctx)).toBe(
        `v-${col.column}`,
      )
      expect(() => decryptSecret(row[col.column] as string, own[col.family], ctx)).toThrow()
    }
    const settings = JSON_COLUMNS.find((c) => c.table === "organizations")
    expect(settings).toBeDefined()
    const row: Record<string, unknown> = {
      settings: {
        providerKeys: {
          openai: { apiKey: encryptSecret("sk", own.byok, CryptoContext.byokApiKey) },
        },
        app: { secret: encryptSecret("s", own.encryption, CryptoContext.orgSettingsSecret) },
        plain: "kept",
      },
    }
    rekeyRowForExport("kernel.organizations", row, own, transfer, tally)
    const s = row.settings as {
      providerKeys: { openai: { apiKey: string } }
      app: { secret: string }
      plain: string
    }
    expect(
      decryptSecret(s.providerKeys.openai.apiKey, transfer.byok, CryptoContext.byokApiKey),
    ).toBe("sk")
    expect(decryptSecret(s.app.secret, transfer.encryption, CryptoContext.orgSettingsSecret)).toBe(
      "s",
    )
    expect(s.plain).toBe("kept")
    expect(tally.byok).toBe(1)
    expect(tally.encryption).toBe(COLUMNS.filter((c) => c.family === "encryption").length + 1)
  })

  it("refuses a value the instance key cannot open", () => {
    const own = { encryption: randomBytes(32).toString("hex"), byok: undefined }
    const row = {
      totp_secret: encryptSecret("x", randomBytes(32).toString("hex"), CryptoContext.totpSecret),
    }
    expect(() =>
      rekeyRowForExport("kernel.users", row, own, generateTransferKeys(), {
        encryption: 0,
        byok: 0,
      }),
    ).toThrow(RekeyRefused)
    const byok = {
      settings: {
        providerKeys: {
          a: encryptSecret("k", randomBytes(32).toString("hex"), CryptoContext.byokApiKey),
        },
      },
    }
    expect(() =>
      rekeyRowForExport("kernel.organizations", byok, own, generateTransferKeys(), {
        encryption: 0,
        byok: 0,
      }),
    ).toThrow(/no byok key/)
  })

  it("accepts only two 64-hex transfer keys", () => {
    const k = generateTransferKeys()
    expect(parseTransferKeys(JSON.stringify(k))).toEqual(k)
    expect(() => parseTransferKeys("not json")).toThrow()
    expect(() => parseTransferKeys(JSON.stringify({ encryption: k.encryption }))).toThrow()
    expect(() => parseTransferKeys(JSON.stringify({ ...k, byok: "short" }))).toThrow()
  })
})

/**
 * Every server file that uses JWT_SECRET, and what a move does to it. Each
 * instance keeps its own JWT_SECRET (a shared one would let any instance forge
 * tokens for every other), so whatever it signs is per instance.
 */
const JWT_SECRET_USES: Record<string, string> = {
  "app.ts":
    "access tokens: the client refreshes on the target (refresh sessions are hashed org rows, they move)",
  "middleware/maintenance.ts": "access token check: as above",
  "modules/auth/auth.ts":
    "access tokens and sign-in links: refresh on the target; a link mailed before the move is asked again",
  "modules/demo/routes.ts": "demo routes: a demo org is never moved",
  "modules/demo/scenarios-routes.ts": "demo routes: a demo org is never moved",
  "modules/demo/demo-verification.ts": "demo verification: a demo org is never moved",
  "modules/files/service.ts":
    "file upload/download tokens: 15/5 min TTL, a link minted before the move stops working",
  "modules/export/org-archive/routes.ts":
    "archive download token: short-lived, the export is asked again on the target",
  "modules/apps/ui-bundle-token.ts": "UI bundle tokens: re-minted on the next page load",
  "modules/mcp/connection-service.ts":
    "MCP connection tokens: after the commit the org's MCP clients reconnect (accepted, gate G-P4-1; the after-commit step marks them)",
  "modules/agent/mailbox-plaintext/mailbox-forward.ts":
    "process-to-process signing of in-flight decrypt answers: nothing persisted, none in flight after the drain",
  "apps/api-connector/store.ts":
    "credential cache version (Redis cache key): recomputed on the target, nothing persisted",
  "apps/tickets/self-send-marker.ts":
    "marker on mail the org sent: the post-move history sync starts at the freeze's historyId after a full drain, so mail sent before the move is not re-read",
  "modules/auth/setup-token.ts": "first-run setup token of the instance: not an org's",
  "cli/agent/ask.ts": "a token the CLI mints for itself on this instance",
  "seed/tiers/minimal.ts": "seed tokens on this instance",
  "lib/env.ts": "the variable's definition",
  "cli/index.ts": "a comment: the CLI runs without it",
  "cli/org-transfer.ts": "a comment: each instance keeps its own on a move",
  "modules/org/transfer/after-commit.ts":
    "a comment: why the after-commit step revokes the carried MCP connections",
  "modules/apps/sandbox/worker-pool.ts": "a comment: sandboxed apps never receive it",
}

describe("JWT_SECRET on a move", () => {
  it("every use is listed with its answer", async () => {
    const found: string[] = []
    for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: SRC })) {
      if (/\.test\.ts$|^tests\/|__fixtures__\/|^test-support\//.test(file)) continue
      const body = await Bun.file(path.join(SRC, file)).text()
      if (/\bJWT_SECRET\b/.test(body)) found.push(file)
    }
    expect(found.sort()).toEqual(Object.keys(JWT_SECRET_USES).sort())
  })
})
