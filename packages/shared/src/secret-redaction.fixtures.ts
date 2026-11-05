// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Test fixtures of the import redaction (secret-redaction.ts), shared by its
 * own tests and by the sidecar's pipeline tests (the follow host's replay and
 * stream, the Take over's catch-up). Every value is built at runtime from
 * parts: no literal secret sits in this public repository.
 */

/** A password-shaped value no key shape recognises. */
export const FIXTURE_PW = ["hun", "ter", "2Zq"].join("")
const PW = FIXTURE_PW

/**
 * B2-2 (D52): every form a secret assignment reaches a transcript in, each
 * line with the value it must lose. Shared with the follow host's and the
 * catch-up's pipeline tests (follow-host.test.ts, unattended.test.ts).
 */
export const B2_2_FORMS: ReadonlyArray<{ form: string; line: string; kept: string }> = [
  {
    form: "Grep path with a space (macOS)",
    line: `/Users/me/Library/Application Support/x/.env:3:DB_PASSWORD=${PW}`,
    kept: "/Users/me/Library/Application Support/x/.env:3:DB_PASSWORD=",
  },
  {
    form: "Grep path with a space (Windows)",
    line: `C:\\Program Files\\app\\.env:3:DB_PASSWORD=${PW}`,
    kept: "Program Files",
  },
  {
    form: "Grep path with a -digits- directory",
    line: `backup-2024-01/.env:3:DB_PASSWORD=${PW}`,
    kept: "backup-2024-01/.env:3:",
  },
  {
    form: "Grep context line under a -N- directory",
    line: `releases/v-2-final/.env-3-DB_PASSWORD=${PW}`,
    kept: "releases/v-2-final/",
  },
  { form: "Grep without -n", line: `config/.env:DB_PASSWORD=${PW}`, kept: "config/.env:" },
  {
    form: "docker-compose environment list",
    line: `      - POSTGRES_PASSWORD=${PW}`,
    kept: "      - POSTGRES_PASSWORD=",
  },
  {
    form: "docker-compose list after a Read prefix",
    line: `    14\t      - POSTGRES_PASSWORD=${PW}`,
    kept: "POSTGRES_PASSWORD=",
  },
  { form: "Dockerfile ENV with =", line: `ENV DB_PASSWORD=${PW}`, kept: "ENV DB_PASSWORD=" },
  { form: "Dockerfile ENV with a blank", line: `ENV DB_PASSWORD ${PW}`, kept: "ENV DB_PASSWORD " },
  {
    form: "docker run -e",
    line: `docker run -e DB_PASSWORD=${PW} --rm app`,
    kept: "docker run -e DB_PASSWORD=",
  },
  { form: "a shell prompt's export", line: `$ export X_TOKEN=${PW}`, kept: "$ export X_TOKEN=" },
  { form: "after a ;", line: `FOO=1; DB_PASSWORD=${PW}`, kept: "FOO=1; DB_PASSWORD=" },
  { form: "a CRLF line", line: `DB_PASSWORD=${PW}\r`, kept: "DB_PASSWORD=" },
  { form: "an HTTP header", line: `X-Api-Key: ${PW}`, kept: "X-Api-Key: " },
  { form: "a DSN", line: `SENTRY_DSN=${PW}`, kept: "SENTRY_DSN=" },
]

/** A second value, so a multi-line value's later lines are checked apart. */
export const FIXTURE_PW2 = ["Zq", "9Xw", "Lp7"].join("")
const PW2 = FIXTURE_PW2

/**
 * B2-6 (D52): values that run past their line, and the netrc and pgpass
 * lines. Each `text` must lose PW and PW2 and keep every `kept` part.
 */
export const B2_6_FORMS: ReadonlyArray<{ form: string; text: string; kept: string[] }> = [
  {
    form: "a double-quoted .env value over two lines",
    text: `DB_PASSWORD="${PW}\n${PW2}"\nPORT=5432`,
    kept: ["DB_PASSWORD=", "\nPORT=5432"],
  },
  {
    form: "a single-quoted value over three Read lines",
    text: `1\tAPI_TOKEN='${PW}\n2\t${PW2}\n3\tend'\n4\tPORT=5432`,
    kept: ["1\tAPI_TOKEN='", "4\tPORT=5432"],
  },
  {
    form: "a YAML literal block under a secret key",
    text: `db:\n  password: |\n    ${PW}\n    ${PW2}\n  host: db`,
    kept: ["  password: |", "  host: db"],
  },
  {
    form: "a YAML folded block after Read prefixes",
    text: `3\t  api_token: >-\n4\t    ${PW}\n5\t\n6\t    ${PW2}\n7\t  host: db`,
    kept: ["3\t  api_token: >-", "7\t  host: db"],
  },
  {
    form: "a .netrc line",
    text: `machine api.example.com login app password ${PW}`,
    kept: ["machine api.example.com login app password "],
  },
  {
    form: "a .netrc password on its own line",
    text: `machine api.example.com\n  login app\n  password ${PW}\nmachine b`,
    kept: ["  login app", "\nmachine b"],
  },
  {
    form: "a .pgpass line",
    text: `db.example.com:5432:app:owner:${PW}`,
    kept: ["db.example.com:5432:app:owner:"],
  },
  {
    form: "a .pgpass line with wildcards after a Read prefix",
    text: `1\t*:*:*:owner:${PW}`,
    kept: ["1\t*:*:*:owner:"],
  },
]
