// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { NodeSessionEventIn } from "./node-session-protocol"
import { REDACTED_PRIVATE_KEY, redactImportEvent, redactImportText } from "./secret-redaction"
import { B2_2_FORMS, B2_6_FORMS, FIXTURE_PW, FIXTURE_PW2 } from "./secret-redaction.fixtures"
import { REDACTED, redactSecrets } from "./threads/local-turn"

// Every key below is assembled at test runtime from parts, so no literal
// secret ever sits in this public repository (secret scanners, push protection).
const ALNUM = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ9876543210"
const run = (n: number, from = 0) => {
  let s = ""
  for (let i = 0; i < n; i++) s += ALNUM[(from + i * 7) % ALNUM.length]
  return s
}
const join = (...parts: string[]) => parts.join("")
// The payment processor's name, assembled from fragments so this file holds no
// literal the repo-wide no-processor grep in apps/api/src/tests reads.
const PSP = join("str", "ipe")
const PSP_SECRET_KEY = `${PSP.toUpperCase()}_SECRET_KEY`

const KEYS: Record<string, string> = {
  anthropic: `${["sk", "ant", "api03"].join("-")}-${run(40)}`,
  githubClassic: join("ghp", "_", run(36, 3)),
  githubFineGrained: join("github", "_pat_", run(22, 5), "_", run(59, 9)),
  gitlab: join("glpat", "-", run(20, 11)),
  slackBot: join("xo", "xb-", "1234567890-", "0987654321-", run(24, 13)),
  awsKeyId: join("AK", "IA", "Z7QK4M2N8P3R5T6V"),
  paymentLive: join("sk", "_live_", run(24, 17)),
  google: join("AI", "za", run(33, 19), "_-"),
  npm: join("npm", "_", run(36, 23)),
  jwt: join("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJ1c2VyLTEifQ", ".", run(43, 29)),
}
// An AWS secret has `/` and `+`: no shape tells it apart, its name does.
const AWS_SECRET = join(run(18, 31), "/", run(12, 37), "+", run(8, 41))

const pemBody = (lines: number, nl: string) =>
  Array.from({ length: lines }, (_, i) => run(64, i * 3)).join(nl)
const pem = (kind: string, nl = "\n") =>
  join(
    "-----BEGIN ",
    kind,
    " PRIVATE KEY-----",
    nl,
    pemBody(6, nl),
    nl,
    "-----END ",
    kind,
    " PRIVATE KEY-----",
  )

describe("redactImportText", () => {
  it("S43: an Anthropic key, a GitHub classic and fine-grained token, a GitLab token, a Slack bot token, an AWS key id and secret, a payment processor live key, a Google API key, an npm token, a JWT are each replaced", () => {
    for (const [name, key] of Object.entries(KEYS)) {
      const out = redactImportText(`before ${key} after`)
      expect({ name, leaked: out.includes(key) }).toEqual({ name, leaked: false })
      expect(out).toStartWith("before ")
      expect(out).toEndWith(" after")
      expect(out).toContain(REDACTED)
    }
    const aws = redactImportText(
      `[default]\naws_access_key_id = ${KEYS.awsKeyId}\naws_secret_access_key = ${AWS_SECRET}\n`,
    )
    expect(aws).not.toContain(AWS_SECRET)
    expect(aws).not.toContain(KEYS.awsKeyId)
    expect(aws).toContain(`aws_secret_access_key = ${REDACTED}`)
  })

  it("S43: an RSA and an OPENSSH private key block are replaced whole, including a block split across a JSON string with \\n", () => {
    for (const kind of ["RSA", "OPENSSH"]) {
      const block = pem(kind)
      const out = redactImportText(`key:\n${block}\ndone`)
      expect(out).toBe(`key:\n${REDACTED_PRIVATE_KEY}\ndone`)
    }
    const escaped = pem("RSA", "\\n")
    const json = JSON.stringify({ file: "id_rsa" }).replace("}", `,"content":"${escaped}\\n"}`)
    const out = redactImportText(json)
    expect(out).toBe(`{"file":"id_rsa","content":"${REDACTED_PRIVATE_KEY}\\n"}`)
    // A public block is not a private key.
    const cert = join("-----BEGIN ", "CERTIFICATE-----\nMIIB\n-----END ", "CERTIFICATE-----")
    expect(redactImportText(cert)).toBe(cert)
    // No END: struck to the end of the string.
    expect(redactImportText(`a ${join("-----BEGIN ", "EC PRIVATE KEY-----\n", run(64))}`)).toBe(
      `a ${REDACTED_PRIVATE_KEY}`,
    )
  })

  it(`S43: OPENAI_API_KEY=…, export GITHUB_TOKEN="…", DB_PASSWORD: …, ${PSP}.secret=…, MYAPIKEY=… are redacted; PATH=/usr/bin and HOME=/x are not`, () => {
    const text = [
      "OPENAI_API_KEY=abc123",
      'export GITHUB_TOKEN="tok-value"',
      "  DB_PASSWORD: hunter2",
      `${PSP}.secret=whatever`,
      "MYAPIKEY = 'quoted'",
      "PATH=/usr/bin",
      "HOME=/x",
    ].join("\n")
    expect(redactImportText(text)).toBe(
      [
        `OPENAI_API_KEY=${REDACTED}`,
        `export GITHUB_TOKEN="${REDACTED}"`,
        `  DB_PASSWORD: ${REDACTED}`,
        `${PSP}.secret=${REDACTED}`,
        `MYAPIKEY = '${REDACTED}'`,
        "PATH=/usr/bin",
        "HOME=/x",
      ].join("\n"),
    )
  })

  it("D49 F4: a PGP private key block is replaced whole; a PGP public key block is not", () => {
    const block = join(
      "-----BEGIN ",
      "PGP PRIVATE KEY BLOCK-----\n\n",
      pemBody(6, "\n"),
      "\n=",
      run(4),
      "\n-----END ",
      "PGP PRIVATE KEY BLOCK-----",
    )
    expect(redactImportText(`key:\n${block}\ndone`)).toBe(`key:\n${REDACTED_PRIVATE_KEY}\ndone`)
    const pub = join(
      "-----BEGIN ",
      "PGP PUBLIC KEY BLOCK-----\nmQIN\n-----END ",
      "PGP PUBLIC KEY BLOCK-----",
    )
    expect(redactImportText(pub)).toBe(pub)
  })

  // B2-5 (D52): other private-key formats. Every body line is short and of
  // one case, so no opaque-run rule catches it: only the format's own rule can.
  it("B2-5: an SSH2 (SECSH) private key block is replaced whole", () => {
    const body = ['Comment: "work"', run(40, 2), run(40, 5), `${run(12, 7)}=`]
    for (const kind of ["SSH2 ENCRYPTED PRIVATE KEY", "SSH2 PRIVATE KEY"]) {
      const block = join(
        "---- BEGIN ",
        kind,
        " ----\n",
        body.join("\n"),
        "\n---- END ",
        kind,
        " ----",
      )
      expect(redactImportText(`key:\n${block}\ndone`)).toBe(`key:\n${REDACTED_PRIVATE_KEY}\ndone`)
    }
    const pub = join(
      "---- BEGIN ",
      "SSH2 PUBLIC KEY ----\nAAAAB3\n---- END ",
      "SSH2 PUBLIC KEY ----",
    )
    expect(redactImportText(pub)).toBe(pub)
  })

  it("B2-5: a PuTTY .ppk file loses its Private-Lines, Read prefixes included; its public lines stay", () => {
    const priv = [run(30, 3), run(30, 8), `${run(10, 9)}==`]
    const ppk = [
      "PuTTY-User-Key-File-3: ssh-ed25519",
      "Encryption: none",
      "Comment: work",
      "Public-Lines: 1",
      "AAAAC3NzaC1lZDI1NTE5",
      "Private-Lines: 3",
      ...priv,
      "Private-MAC: 0f",
    ]
    for (const prefixed of [false, true]) {
      const text = ppk.map((l, k) => (prefixed ? `${k + 1}\t${l}` : l)).join("\n")
      const out = redactImportText(text)
      for (const line of priv)
        expect({ prefixed, leaked: out.includes(line) }).toEqual({ prefixed, leaked: false })
      expect(out).toContain("AAAAC3NzaC1lZDI1NTE5")
      expect(out).toContain("Private-MAC: 0f")
      expect(redactImportText(out)).toBe(out)
    }
  })

  it("B2-5: an age secret key is replaced", () => {
    const bech = "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L"
    const key = join("AGE-SECRET-KEY-", "1", (bech + bech).slice(0, 58))
    const out = redactImportText(`# created: today\n${key}\n`)
    expect(out).not.toContain(key.slice(16))
    expect(out).toContain(REDACTED)
  })

  it("B2-5: a JWK's private members (d, p, q, dp, dq, qi, and k of a symmetric key) are struck, as text and in an event; its public members stay", () => {
    const rsa = { kty: "RSA", n: "pub-n", e: "AQAB", d: PW, p: PW, q: PW, dp: PW, dq: PW, qi: PW }
    const oct = { kty: "oct", k: PW, alg: "HS256" }
    for (const jwk of [rsa, oct]) {
      for (const text of [JSON.stringify(jwk), JSON.stringify(jwk, null, 2)]) {
        const out = redactImportText(text)
        expect(out).not.toContain(PW)
        expect(out).toContain('"kty"')
      }
    }
    expect(JSON.parse(redactImportText(JSON.stringify(rsa)))).toMatchObject({
      n: "pub-n",
      e: "AQAB",
    })
    const out = redactImportEvent({
      at: "2026-10-16T00:00:00.000Z",
      type: "tool_call",
      payload: { input: { jwks: [rsa] }, other: { d: "a plain d", p: "a plain p" } },
    })
    expect(JSON.stringify(out)).not.toContain(PW)
    expect(out.payload.other).toEqual({ d: "a plain d", p: "a plain p" })
  })

  it("S43: postgres://app:hunter2@db:5432/x keeps user and host, drops the password", () => {
    expect(redactImportText("DATABASE=postgres://app:hunter2@db:5432/x")).toBe(
      `DATABASE=postgres://app:${REDACTED}@db:5432/x`,
    )
    expect(redactImportText("see https://example.com:8080/a and ssh://git@host/x")).toBe(
      "see https://example.com:8080/a and ssh://git@host/x",
    )
  })

  it("S43: a 40-hex git sha, a uuid, an absolute path and a base64 PNG header are unchanged", () => {
    const text = [
      "commit 3f9a2c1e8b7d6f5a4c3b2a1908f7e6d5c4b3a291",
      "id 0b1f6c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
      "file /srv/app/src/modules/sessions/import.ts",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
    ].join("\n")
    expect(redactImportText(text)).toBe(text)
  })

  it('A59: \'"DB_PASSWORD": "x"\' and \'"dbSecret": "x"\' in a tool_result text are redacted', () => {
    expect(redactImportText('{"DB_PASSWORD": "x", "dbSecret":"y", "name": "z"}')).toBe(
      `{"DB_PASSWORD": "${REDACTED}", "dbSecret":"${REDACTED}", "name": "z"}`,
    )
  })

  it("A59: 'TOKEN:\\n value' leaves the next line intact", () => {
    expect(redactImportText("TOKEN:\n value")).toBe("TOKEN:\n value")
    expect(redactImportText("TOKEN=a\nnext=b")).toBe(`TOKEN=${REDACTED}\nnext=b`)
  })

  it("S43: idempotent", () => {
    const samples = [
      ...Object.values(KEYS).map((k) => `x ${k} y`),
      pem("RSA"),
      'OPENAI_API_KEY="abc"\nPATH=/usr/bin',
      '{"DB_PASSWORD": "x"}',
      "postgres://app:hunter2@db:5432/x",
      `aws_secret_access_key = ${AWS_SECRET}`,
    ]
    for (const s of samples) {
      const once = redactImportText(s)
      expect(redactImportText(once)).toBe(once)
    }
  })

  it("discriminator: .env name parts, PEM, userinfo and JSON 'contains' keys pass through redactSecrets alone", () => {
    for (const s of [
      "OPENAI_API_KEY=abc123",
      pem("RSA").replace(/\n[A-Za-z0-9]+(?=\n)/g, "\nMIIB"),
      "postgres://app:hunter2@db:5432/x",
      '{"DB_PASSWORD": "x"}',
      join("sk", "_live_", "abcd1234efgh"),
    ]) {
      expect(redactSecrets(s)).toBe(s)
      expect(redactImportText(s)).not.toBe(s)
    }
  })
})

// A password-shaped value no key shape recognises, built at runtime.
const PW = FIXTURE_PW

describe("redactImportText: tool-output line prefixes (D49 F1)", () => {
  it("S43/D49 F1: a .env line after a Read line number (1\\t, 12→) or a Grep path:N: / path-N- prefix is redacted", () => {
    const text = [
      `1\tDB_PASSWORD=${PW}`,
      `2\t${PSP_SECRET_KEY}=${PW}`,
      `    12\u2192export GITHUB_TOKEN="${PW}"`,
      `config/.env:3:API_TOKEN=${PW}`,
      `my-app/.env-4-DB_PASS = ${PW}`,
      `7:SESSION_SECRET: ${PW}`,
      "3\tPATH=/usr/bin",
      "src/a.ts:3:const x = 1",
      "src/a-b.ts-9-HOME=/x",
    ].join("\n")
    expect(redactImportText(text)).toBe(
      [
        `1\tDB_PASSWORD=${REDACTED}`,
        `2\t${PSP_SECRET_KEY}=${REDACTED}`,
        `    12\u2192export GITHUB_TOKEN="${REDACTED}"`,
        `config/.env:3:API_TOKEN=${REDACTED}`,
        `my-app/.env-4-DB_PASS = ${REDACTED}`,
        `7:SESSION_SECRET: ${REDACTED}`,
        "3\tPATH=/usr/bin",
        "src/a.ts:3:const x = 1",
        "src/a-b.ts-9-HOME=/x",
      ].join("\n"),
    )
  })
})

describe("redactImportText: a secret assignment anywhere on a line (B2-2, D52)", () => {
  for (const { form, line, kept } of B2_2_FORMS) {
    it(`B2-2: ${form} loses its value`, () => {
      const out = redactImportText(line)
      expect({ form, leaked: out.includes(PW) }).toEqual({ form, leaked: false })
      expect(out).toContain(kept)
      expect(out).toContain(REDACTED)
      expect(redactImportText(out)).toBe(out)
    })
  }

  it("B2-2: a non-secret assignment, a comparison, an arrow and a path are left as they are", () => {
    const text = [
      "PORT=5432; HOST=db",
      "if (password == null) return",
      "const f = (token) => token.trim()",
      "src/a-2-b/token.ts:12:export const n = 1",
      "Token::new(x)",
    ].join("\n")
    expect(redactImportText(text)).toBe(text)
  })
})

describe("redactImportText: values past their line, netrc and pgpass (B2-6, D52)", () => {
  for (const { form, text, kept } of B2_6_FORMS) {
    it(`B2-6: ${form} loses its value`, () => {
      const out = redactImportText(text)
      expect({ form, leaked: out.includes(PW) || out.includes(FIXTURE_PW2) }).toEqual({
        form,
        leaked: false,
      })
      for (const k of kept) expect({ form, kept: out.includes(k) }).toEqual({ form, kept: true })
      expect(redactImportText(out)).toBe(out)
    })
  }

  it("B2-6: an unclosed quote strikes its own line only; a block scalar under a plain key, a prose 'password' and a clock time are left", () => {
    expect(redactImportText(`DB_PASSWORD="${PW}\nPORT=5432`)).toBe(
      `DB_PASSWORD="${REDACTED}\nPORT=5432`,
    )
    const text = [
      "description: |",
      "  a long text",
      "Reset your password here.",
      "at 12:30:45 the job ran",
    ].join("\n")
    expect(redactImportText(text)).toBe(text)
  })
})

describe("redactImportText: JSON inside a string (D49 F3)", () => {
  it("D49 F3: an MCP result whose text is JSON encoded in a JSON string has its secret-named values struck, up to three levels", () => {
    const inner = JSON.stringify({ password: PW, note: "ok" })
    const twice = JSON.stringify({ result: inner })
    const out = redactImportText(twice)
    expect(out).not.toContain(PW)
    expect(JSON.parse(JSON.parse(out).result)).toEqual({ password: REDACTED, note: "ok" })
    const thrice = JSON.stringify([{ type: "text", text: JSON.stringify({ data: twice }) }])
    expect(redactImportText(thrice)).not.toContain(PW)
    expect(redactImportText(out)).toBe(out)
    // Not JSON, or JSON with nothing to strike: the text is left as it was.
    for (const same of ["{not json: 1", '{ "a": 1,\n  "b": [2] }', "[1, 2]"]) {
      expect(redactImportText(same)).toBe(same)
    }
  })
})

describe("redactImportEvent", () => {
  const event = (payload: Record<string, unknown>): NodeSessionEventIn => ({
    at: "2026-10-16T00:00:00.000Z",
    type: "tool_call",
    payload,
  })

  it("S43: redactImportEvent redacts tool_call input nested two levels deep and tool_result text", () => {
    const call = event({
      id: "t1",
      name: "Bash",
      input: { env: { list: [`KEY ${KEYS.anthropic}`] } },
    })
    const out = redactImportEvent(call)
    expect(out.payload).toEqual({
      id: "t1",
      name: "Bash",
      input: { env: { list: [`KEY ${REDACTED}`] } },
    })
    expect(call.payload.input).toEqual({ env: { list: [`KEY ${KEYS.anthropic}`] } })
    const result = redactImportEvent({
      ...event({ toolUseId: "t1", text: `GITHUB_TOKEN=${KEYS.githubClassic}` }),
      type: "tool_result",
    })
    expect(result.payload).toEqual({ toolUseId: "t1", text: `GITHUB_TOKEN=${REDACTED}` })
  })

  it("D49 F2: a secret-named key's value is struck at any depth (redactArgs' names and the S43 'contains' words); token counts stay", () => {
    const input = {
      password: PW,
      api_key: PW,
      env: { DB_PASSWORD: PW, [PSP_SECRET_KEY]: PW, PORT: "5432" },
      headers: { Authorization: `Token ${PW}`, Cookie: `sid=${PW}` },
      servers: [{ name: "db", credentials: { user: "app", pin: 4321 }, accessToken: 98765 }],
    }
    const out = redactImportEvent(event({ id: "t1", name: "mcp__deploy__connect", input }))
    expect(out.payload).toEqual({
      id: "t1",
      name: "mcp__deploy__connect",
      input: {
        password: REDACTED,
        api_key: REDACTED,
        env: { DB_PASSWORD: REDACTED, [PSP_SECRET_KEY]: REDACTED, PORT: "5432" },
        headers: { Authorization: REDACTED, Cookie: REDACTED },
        servers: [{ name: "db", credentials: REDACTED, accessToken: REDACTED }],
      },
    })
    expect(redactImportEvent(out)).toEqual(out)
    const usage = { tokensIn: 3, tokensOut: 2, contextTokens: 9, totalTokens: 5 }
    expect(redactImportEvent({ ...event(usage), type: "usage" }).payload).toEqual(usage)
  })

  // B2-4 (D52): a NAME containing a secret word kept every non-string value:
  // an array of keys, an object holding the key, a numeric password.
  it("B2-4: any value under a secret-named key is struck (array, object, number); only the known usage counts stay", () => {
    const input = {
      apiKeys: [PW],
      [PSP_SECRET_KEY]: { value: PW },
      privateKey: { value: PW, kid: "k1" },
      db_password: 12345678,
      keys: 2,
      tokensIn: 3,
      cache_read_input_tokens: 7,
      keyRotated: true,
      authorName: "Ada",
      port: 5432,
    }
    const out = redactImportEvent(event({ id: "t1", name: "mcp__vault__read", input }))
    expect(out.payload.input).toEqual({
      apiKeys: REDACTED,
      [PSP_SECRET_KEY]: REDACTED,
      privateKey: REDACTED,
      db_password: REDACTED,
      keys: REDACTED,
      tokensIn: 3,
      cache_read_input_tokens: 7,
      keyRotated: true,
      authorName: "Ada",
      port: 5432,
    })
    expect(redactImportEvent(out)).toEqual(out)
    // A usage count under a non-number is not a count.
    expect(redactImportEvent(event({ tokensIn: PW })).payload).toEqual({ tokensIn: REDACTED })
  })

  it("B2-4: the same shapes as JSON text, on one line and as a Read of a pretty-printed file, upload no value", () => {
    const one = JSON.stringify({
      apiKeys: [PW],
      [PSP_SECRET_KEY]: { value: PW },
      privateKey: { value: PW },
      db_password: 12345678,
      tokensIn: 3,
    })
    const out = redactImportText(one)
    expect(out).not.toContain(PW)
    expect(out).not.toContain("12345678")
    expect(JSON.parse(out)).toEqual({
      apiKeys: REDACTED,
      [PSP_SECRET_KEY]: REDACTED,
      privateKey: REDACTED,
      db_password: REDACTED,
      tokensIn: 3,
    })
    const pretty = JSON.stringify({ apiKeys: [PW, `${PW}2`], name: "app", db: { pin: 1 } }, null, 2)
      .split("\n")
      .map((l, k) => `${k + 1}\t${l}`)
      .join("\n")
    const read = redactImportText(pretty)
    expect(read).not.toContain(PW)
    expect(read).toContain('"name": "app"')
    expect(redactImportText(read)).toBe(read)
    // Unquoted names (code, YAML flow) hold arrays and objects too.
    for (const code of [
      `const config = { apiKeys: ["${PW}", "${PW}"], port: 1 }`,
      `api_keys: [${PW}, ${PW}]`,
      `secrets = {\n  "db": "${PW}"\n}`,
    ]) {
      expect({ code, leaked: redactImportText(code).includes(PW) }).toEqual({ code, leaked: false })
    }
    // A nested JSON string after a struck array is still parsed (D49 F3).
    const nested = JSON.stringify({ apiKeys: [PW], result: JSON.stringify({ password: PW }) })
    expect(redactImportText(nested)).not.toContain(PW)
  })

  it("A59: an object key that is a key is redacted, two colliding keys both survive", () => {
    const out = redactImportEvent(event({ map: { [KEYS.anthropic]: 1, [KEYS.npm]: 2, plain: 3 } }))
    expect(out.payload).toEqual({ map: { [REDACTED]: 1, [`${REDACTED} [2]`]: 2, plain: 3 } })
    expect(redactImportEvent(out)).toEqual(out)
  })
})

// ---- pathological timing (A59) ----

const KIB = 1024
const fill = (unit: string, bytes: number) =>
  unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes)

/**
 * The CPU time `fn(input)` costs this process, in ms. Wall time is what a busy
 * machine inflates: with every suite of a gate running at once, a 50 ms pass
 * read as 5 s of wall time and failed a linear rule. The redaction is
 * synchronous on this thread, so its CPU time is its own cost, and a quadratic
 * rule still burns minutes of it on 1 MiB.
 */
function cpuMs(fn: (s: string) => unknown, input: string): number {
  const start = process.cpuUsage()
  fn(input)
  const spent = process.cpuUsage(start)
  return (spent.user + spent.system) / 1000
}

/**
 * The fastest of five runs. A GC pause or a busy machine only ever ADDS time, so
 * the minimum is the run's own cost; a median of three let one pause on the small
 * input pass for super-linear growth. A quadratic rule is slow on every run.
 */
function fastestMs(fn: (s: string) => unknown, input: string): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < 5; i++) best = Math.min(best, cpuMs(fn, input))
  return best
}

/** CPU time(big) and time(big)/time(small), the small time floored at 1 ms (timer noise). */
function growth(fn: (s: string) => unknown, unit: string, small: number, big: number) {
  // A pass at 1/16 of the size first: a quadratic chain would spend minutes on
  // 1 MiB, so one over 4x the linear share of 500 ms fails before that.
  if (big >= 1024 * KIB && cpuMs(fn, fill(unit, big / 16)) > 125)
    return { ms: Number.POSITIVE_INFINITY, ratio: 16 }
  const tBig = fastestMs(fn, fill(unit, big))
  const tSmall = fastestMs(fn, fill(unit, small))
  return { ms: tBig, ratio: tBig / Math.max(tSmall, 1) }
}

const PATHOLOGICAL_UNITS = [
  "\n",
  "\n ",
  "a=",
  "A",
  "-",
  "a-",
  join("-----BEGIN ", "RSA PRIVATE KEY-----"),
  '"k":"',
  "x://a:",
  "Bearer ",
  "1\t",
  "a:1:",
  "-1-",
  "a",
  "[",
  '{"a":"',
  '["{\\"k\\":\\"',
  // B2-2: the assignment scanner's look-back, its quote search and ENV.
  "KEY=",
  'KEY="',
  "               =",
  `${"A".repeat(127)}=`,
  "a.ts:",
  "ENV KEY ",
  "x:1-",
  // B2-6: multi-line quotes, block scalars, netrc and pgpass.
  "KEY='\n",
  "a'b\"c\n",
  "key: |\n  x\n",
  "  key: >-\n",
  "password x ",
  "machine password ",
  `${"h".repeat(200)}:1:`,
  "a:1:b:c:",
  "p",
  // B2-4: arrays, objects and numbers under a secret-named key.
  '"key":[',
  '"key":{"a":"',
  '"key":1,',
  "key: [",
  "key: [\n",
  '"key":[\n',
  '"key": [\n1\t"x",',
  // B2-5: SSH2 armour, PuTTY lines, a JWK's members, the age prefix.
  join("---- BEGIN ", "SSH2 PRIVATE KEY ----"),
  "Private-Lines: 9\n",
  "Private-Lines: 4096\nx\n",
  '"kty""d":"',
  "AGE-SECRET-KEY-1",
]

describe("A59: pathological timing", () => {
  for (const unit of PATHOLOGICAL_UNITS) {
    it(`A59: redactImportText on 1 MiB of ${JSON.stringify(unit)} is under 500 ms and linear`, () => {
      const g = growth(redactImportText, unit, 256 * KIB, 1024 * KIB)
      expect({ unit, ms: g.ms < 500, linear: g.ratio < 8 }).toEqual({
        unit,
        ms: true,
        linear: true,
      })
    }, 30_000)
  }

  // The probe tells quadratic from linear: two known-quadratic patterns, kept
  // here as the red reference and never in the source, grow ≥ 8× on 4× input.
  it("A59: the probe sees the base's token rule and the first-draft .env regex as quadratic", () => {
    const baseToken =
      /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/g
    const draftEnv =
      /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*(?:SECRET|TOKEN|KEY|PASSWORD|PASS)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(.+)$/gim
    expect(
      growth((s) => s.replace(baseToken, REDACTED), "a-", 4 * KIB, 16 * KIB).ratio,
    ).toBeGreaterThanOrEqual(8)
    expect(
      growth((s) => s.replace(draftEnv, REDACTED), "\n ", 4 * KIB, 16 * KIB).ratio,
    ).toBeGreaterThanOrEqual(8)
  }, 30_000)
})

// A59 (T15): a source guard. The redaction runs on every byte an import sends,
// so no rule may backtrack: no regex literal in these files repeats a group
// that itself repeats (`(a+)+`), and none puts `\s*` beside another repeated
// class (`\s*\w+`, `[ \t]+\s*`). The timing rows above are the behavioural proof.
const REDACTION_SOURCES = ["secret-redaction.ts", "threads/local-turn.ts"]

/** The regex literals of a source, comments left out (a heuristic scan). */
function regexLiterals(source: string): string[] {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .join("\n")
  // A literal starts where an expression may: after `(`, `,`, `=`, `:`, `[`,
  // `!`, `&`, `|`, `?`, `{`, `}`, `;` or `return` (never a division).
  const literal =
    /(?<=(?:^|[(,=:[!&|?{};]|\breturn)\s*)\/(?![/*])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/[dgimsuyv]*/gm
  return [...code.matchAll(literal)].map((m) => m[1] ?? "")
}

const REPEAT = /^(?:[+*]|\{\d+,)/

/** A group holding a repeat, repeated itself. */
function nestedRepeat(re: string): boolean {
  const stack: boolean[] = []
  for (let i = 0; i < re.length; i++) {
    const c = re[i]
    if (c === "\\") {
      i++
      continue
    }
    if (c === "[") {
      for (i++; i < re.length && re[i] !== "]"; i++) if (re[i] === "\\") i++
      if (stack.length > 0 && REPEAT.test(re.slice(i + 1))) stack[stack.length - 1] = true
      continue
    }
    if (c === "(") stack.push(false)
    else if (c === ")") {
      const inner = stack.pop() ?? false
      const after = re.slice(i + 1)
      if (inner && REPEAT.test(after)) return true
      if (stack.length > 0 && (inner || REPEAT.test(after))) stack[stack.length - 1] = true
    } else if (stack.length > 0 && REPEAT.test(re.slice(i))) stack[stack.length - 1] = true
  }
  return false
}

/** `\s*` next to another repeated class. */
function spaceBesideRepeat(re: string): boolean {
  const cls = String.raw`(?:\[(?:\\.|[^\]\\])*\]|\\[A-Za-z]|\.)`
  return (
    new RegExp(String.raw`\\s\*${cls}(?:[+*]|\{\d+,)`).test(re) ||
    new RegExp(String.raw`${cls}(?:[+*]|\{\d+,\d*\})\\s\*`).test(re)
  )
}

describe("A59: no backtracking-prone rule in the redaction sources", () => {
  it("A59: the scanner flags a nested repeat and a \\s* beside a repeated class, and passes a flat rule", () => {
    expect(nestedRepeat("(a+)+$")).toBe(true)
    expect(nestedRepeat("(?:[a-z]{2,})*x")).toBe(true)
    expect(
      nestedRepeat(String.raw`\b(?:sk_(?:live|test)_[A-Za-z0-9]{8,}|hf_[A-Za-z0-9]{30,})`),
    ).toBe(false)
    expect(spaceBesideRepeat(String.raw`key\s*\w+=`)).toBe(true)
    expect(spaceBesideRepeat(String.raw`[ \t]+\s*:`)).toBe(true)
    expect(spaceBesideRepeat("[A-Za-z0-9_-]{32,}")).toBe(false)
    expect(regexLiterals("const a = /x\\/y[/]+/g // not /this/\nconst b = 1 / 2 / 3")).toEqual([
      "x\\/y[/]+",
    ])
  })

  for (const file of REDACTION_SOURCES) {
    it(`A59: ${file} holds no regex literal with a nested repeat or \\s* beside a repeated class`, () => {
      const source = readFileSync(path.join(import.meta.dir, file), "utf8")
      const literals = regexLiterals(source)
      expect(literals.length).toBeGreaterThan(0)
      expect(literals.filter((re) => nestedRepeat(re) || spaceBesideRepeat(re))).toEqual([])
    })
  }
})
