// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { utf8 } from "./encoding"
import { parseRevocationList, type RevocationList, revocationBytes } from "./revocations"
import {
  parseShellStatement,
  type ShellStatement,
  shellRevocationFor,
  shellStatementBytes,
  verifyShellStatement,
} from "./shell-statement"
import { parseStatement, statementBytes } from "./statement"
import { createTestSigningKey } from "./testing"

function shellStatement(keyId: string, over: Partial<ShellStatement> = {}): ShellStatement {
  return {
    v: 1,
    kind: "shell",
    keyId,
    mode: "desktop",
    buildId: "0123456789abcdef",
    commit: "a".repeat(40),
    seq: 1_764_300_000,
    liaisonVersion: "nightly-20261128",
    bridge: { desktop: "^1", ios: "^1", android: "^1" },
    settingsSchema: 1,
    files: {
      "index.html": "b".repeat(64),
      "assets/index-abc.js": "c".repeat(64),
      "build-id.txt": "d".repeat(64),
    },
    issuedAt: "2026-11-28T00:00:00.000Z",
    ...over,
  }
}

const NO_REVOCATIONS = { list: null, floor: [] } as const

describe("shell statement bytes", () => {
  it("round-trips through the canonical form", () => {
    const s = shellStatement("k1")
    const bytes = shellStatementBytes(s)
    expect(parseShellStatement(bytes)).toEqual(s)
    // Canonical: keys sorted, no whitespace.
    expect(
      utf8.decode(bytes).startsWith('{"bridge":{"android":"^1","desktop":"^1","ios":"^1"},'),
    ).toBe(true)
  })

  it("refuses an unknown key, a wrong kind and malformed fields", () => {
    const s = shellStatement("k1")
    const reparse = (o: unknown) => parseShellStatement(utf8.encode(JSON.stringify(o)))
    expect(reparse({ ...s, extra: 1 })).toBeNull()
    expect(reparse({ ...s, bridge: { ...s.bridge, web: "^1" } })).toBeNull()
    expect(reparse({ ...s, kind: "app" })).toBeNull()
    expect(reparse({ ...s, mode: "web" })).toBeNull()
    expect(reparse({ ...s, buildId: "XYZ" })).toBeNull()
    expect(reparse({ ...s, commit: "abc" })).toBeNull()
    expect(reparse({ ...s, seq: 1.5 })).toBeNull()
    expect(reparse({ ...s, seq: -1 })).toBeNull()
    expect(reparse({ ...s, settingsSchema: "1" })).toBeNull()
    expect(reparse({ ...s, files: {} })).toBeNull()
    expect(reparse({ ...s, files: { "../etc/passwd": "b".repeat(64) } })).toBeNull()
    expect(reparse({ ...s, files: { "/index.html": "b".repeat(64) } })).toBeNull()
    expect(reparse({ ...s, files: { "index.html": "nothex" } })).toBeNull()
    const { kind: _kind, ...noKind } = s
    expect(reparse(noKind)).toBeNull()
  })

  it("an app statement never parses as a shell one, and a shell one never as an app one", () => {
    const app = statementBytes({
      v: 1,
      keyId: "k1",
      name: "boxtal",
      version: "1.2.3",
      hostApi: "^1",
      sha256: { ui: "a".repeat(64), manifest: "b".repeat(64), package: "c".repeat(64) },
      sourceDigest: "d".repeat(64),
      issuedAt: "2026-11-28T00:00:00.000Z",
    })
    expect(parseStatement(app)).not.toBeNull()
    expect(parseShellStatement(app)).toBeNull()
    expect(parseStatement(shellStatementBytes(shellStatement("k1")))).toBeNull()
    // Even an app statement that gained a `kind` field is refused by the app parser.
    const withKind = { ...(JSON.parse(utf8.decode(app)) as object), kind: "shell" }
    expect(parseStatement(utf8.encode(JSON.stringify(withKind)))).toBeNull()
  })
})

describe("verifyShellStatement", () => {
  it("verifies a statement signed by a pinned key", async () => {
    const signer = await createTestSigningKey("k1")
    const bytes = shellStatementBytes(shellStatement("k1"))
    const result = await verifyShellStatement(
      bytes,
      await signer.sign(bytes),
      [signer.key],
      NO_REVOCATIONS,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.statement.buildId).toBe("0123456789abcdef")
  })

  it("refuses a tampered byte", async () => {
    const signer = await createTestSigningKey("k1")
    const bytes = shellStatementBytes(shellStatement("k1"))
    const sig = await signer.sign(bytes)
    // Swap one hex digit of a file hash: still canonical, still parses, signature fails.
    const text = utf8.decode(bytes).replace('"index.html":"b', '"index.html":"e')
    const tampered = utf8.encode(text)
    expect(parseShellStatement(tampered)).not.toBeNull()
    const result = await verifyShellStatement(tampered, sig, [signer.key], NO_REVOCATIONS)
    expect(result).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("refuses a non-canonical encoding of a validly signed statement", async () => {
    const signer = await createTestSigningKey("k1")
    const s = shellStatement("k1")
    const pretty = utf8.encode(JSON.stringify(s, null, 2))
    const result = await verifyShellStatement(
      pretty,
      await signer.sign(pretty),
      [signer.key],
      NO_REVOCATIONS,
    )
    expect(result).toEqual({ ok: false, reason: "malformed_statement" })
  })

  it("refuses a statement signed by another key, or naming an unpinned key", async () => {
    const pinnedKey = await createTestSigningKey("k1")
    const other = await createTestSigningKey("k1")
    const bytes = shellStatementBytes(shellStatement("k1"))
    expect(
      await verifyShellStatement(bytes, await other.sign(bytes), [pinnedKey.key], NO_REVOCATIONS),
    ).toEqual({ ok: false, reason: "bad_signature" })
    const unknown = shellStatementBytes(shellStatement("k2"))
    expect(
      await verifyShellStatement(
        unknown,
        await pinnedKey.sign(unknown),
        [pinnedKey.key],
        NO_REVOCATIONS,
      ),
    ).toEqual({ ok: false, reason: "unknown_key" })
    expect(
      await verifyShellStatement(bytes, await pinnedKey.sign(bytes), [], NO_REVOCATIONS),
    ).toEqual({
      ok: false,
      reason: "no_keys",
    })
  })

  it("refuses a signed app statement offered as a shell one", async () => {
    const signer = await createTestSigningKey("k1")
    const app = statementBytes({
      v: 1,
      keyId: "k1",
      name: "boxtal",
      version: "1.2.3",
      hostApi: "^1",
      sha256: { ui: "a".repeat(64), manifest: "b".repeat(64), package: "c".repeat(64) },
      sourceDigest: "d".repeat(64),
      issuedAt: "2026-11-28T00:00:00.000Z",
    })
    expect(
      await verifyShellStatement(app, await signer.sign(app), [signer.key], NO_REVOCATIONS),
    ).toEqual({
      ok: false,
      reason: "malformed_statement",
    })
  })

  it("refuses a seq below the compiled floor or the downloaded list's floor for its mode", async () => {
    const signer = await createTestSigningKey("k1")
    const bytes = shellStatementBytes(shellStatement("k1", { seq: 100 }))
    const sig = await signer.sign(bytes)
    expect(
      await verifyShellStatement(bytes, sig, [signer.key], {
        list: null,
        floor: [{ name: "shell:desktop", below: "101" }],
      }),
    ).toEqual({ ok: false, reason: "below_floor" })
    const list: RevocationList = {
      v: 1,
      seq: 3,
      issuedAt: "2026-11-28T00:00:00.000Z",
      entries: [{ name: "shell:desktop", below: "200" }],
    }
    expect(await verifyShellStatement(bytes, sig, [signer.key], { list, floor: [] })).toEqual({
      ok: false,
      reason: "revoked",
    })
    // The floor of the other mode, and a floor at the statement's own seq, do not refuse it.
    expect(
      await verifyShellStatement(bytes, sig, [signer.key], {
        list: { ...list, entries: [{ name: "shell:native", below: "200" }] },
        floor: [{ name: "shell:desktop", below: "100" }],
      }),
    ).toMatchObject({ ok: true })
  })
})

describe("shell revocation entries", () => {
  it("parse beside app entries, with a decimal-string floor", () => {
    const list: RevocationList = {
      v: 1,
      seq: 9,
      issuedAt: "2026-11-28T00:00:00.000Z",
      entries: [
        { name: "invoicing", below: "0.19.0" },
        { name: "shell:desktop", below: "1764300000" },
        { name: "shell:native", below: "1764300001" },
      ],
    }
    expect(parseRevocationList(revocationBytes(list))).toEqual(list)
  })

  it("refuse a shell entry with a non-numeric floor, a version list, or an unknown mode", () => {
    const parse = (entry: unknown) =>
      parseRevocationList(
        utf8.encode(JSON.stringify({ v: 1, seq: 1, issuedAt: "x", entries: [entry] })),
      )
    expect(parse({ name: "shell:desktop", below: "1.2.0" })).toBeNull()
    expect(parse({ name: "shell:desktop", below: 12 })).toBeNull()
    expect(parse({ name: "shell:desktop", versions: ["1"] })).toBeNull()
    expect(parse({ name: "shell:desktop", below: "12", versions: ["1"] })).toBeNull()
    expect(parse({ name: "shell:web", below: "12" })).toBeNull()
  })

  it("shellRevocationFor compares the seq numerically, per mode", () => {
    const floor = [{ name: "shell:native", below: "1000" }]
    expect(shellRevocationFor("native", 999, { list: null, floor })).toBe("below_floor")
    expect(shellRevocationFor("native", 1000, { list: null, floor })).toBeNull()
    expect(shellRevocationFor("desktop", 1, { list: null, floor })).toBeNull()
  })
})
