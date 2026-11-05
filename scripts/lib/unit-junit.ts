// SPDX-License-Identifier: FSL-1.1-ALv2
// scripts/lib/unit-junit.ts
//
// bun's junit report, read per test file: whether the file failed, the summed
// time of its test cases, and which tests failed with what. The sharded unit
// runner (scripts/test-unit-parallel.ts) runs files in batches that share one
// process and one stdout, then reruns a file that failed in a batch alone or
// retries it; the per-test failures read here are what it keeps of that first
// attempt, so a file that passes on the second try still says what failed on
// the first.

export type JunitFailure = {
  /** "describe > test", or the test name for a top-level test. */
  name: string
  /** The failure body (error, message and stack), entities decoded. */
  message: string
}

export type JunitSuite = {
  failed: boolean
  /** Summed test-case time: bun leaves the file-level suite `time` at 0. */
  seconds: number
  failures: JunitFailure[]
}

const attr = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      return String.fromCodePoint(code)
    }
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()] ?? `&${e};`
  })
}

/**
 * Parses a junit report into one entry per test file, keyed by `rel(file)`.
 * File-level suites come first per file; bun nests describe blocks as inner
 * <testsuite>s that repeat the file, so the first one per file is the file.
 */
export function parseJunitSuites(
  xml: string,
  rel: (file: string) => string = (f) => f,
): Map<string, JunitSuite> {
  const suites = new Map<string, JunitSuite>()
  for (const m of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const file = attr(m[1] ?? "", "file")
    if (!file || suites.has(rel(file))) continue
    const failures = Number(attr(m[1] ?? "", "failures") ?? 0)
    const errors = Number(attr(m[1] ?? "", "errors") ?? 0)
    suites.set(rel(file), { failed: failures + errors > 0, seconds: 0, failures: [] })
  }
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1] ?? ""
    const file = attr(attrs, "file")
    const suite = file ? suites.get(rel(file)) : undefined
    if (!suite) continue
    suite.seconds += Number(attr(attrs, "time") ?? 0)
    const body = m[2] ?? ""
    const failure = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/)
    if (!failure) continue
    const classname = decodeXml(attr(attrs, "classname") ?? "")
    const name = decodeXml(attr(attrs, "name") ?? "")
    suite.failures.push({
      name: classname ? `${classname} > ${name}` : name,
      message: decodeXml(failure[3] || attr(failure[2] ?? "", "message") || "").trim(),
    })
  }
  return suites
}

/** A few lines per failing test, for the runner's report. */
export function formatFailures(failures: readonly JunitFailure[], maxLines = 12): string {
  return failures
    .map((f) => {
      const lines = f.message.split("\n")
      const shown = lines.slice(0, maxLines).map((l) => `      ${l}`)
      if (lines.length > maxLines) shown.push(`      … (${lines.length - maxLines} more lines)`)
      return [`    (fail) ${f.name}`, ...shown].join("\n")
    })
    .join("\n")
}
