// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What counts as a path on the user's computer in an agent's text, as a table
// per OS style. A path that is missed is a file the person has to find by
// hand; a slash that is linked by mistake is a link to nothing.

import { describe, expect, it } from "vitest"
import {
  delimitedLocalPath,
  findLocalPaths,
  joinLocalPath,
  localPathFromHref,
} from "~/lib/local-paths"

/** The paths found in a sentence, as written. */
function found(text: string): string[] {
  return findLocalPaths(text).map((match) => match.text)
}

describe("paths in bare prose", () => {
  it.each([
    // Windows drive paths, both separators, a space inside a folder name.
    [
      String.raw`Saved to C:\Users\someone\Documents\Reports\Hub X\report-2026-08.pdf and done.`,
      [String.raw`C:\Users\someone\Documents\Reports\Hub X\report-2026-08.pdf`],
    ],
    ["Open C:/Users/someone/out/deck.html.", ["C:/Users/someone/out/deck.html"]],
    ["The folder is D:\\Exports\\ now.", ["D:\\Exports\\"]],
    // POSIX, under a known root or ending in a file name.
    ["Wrote /Users/someone/Reports/report.pdf.", ["/Users/someone/Reports/report.pdf"]],
    ["See /home/someone/out/deck.html, then reload.", ["/home/someone/out/deck.html"]],
    ["It is in /tmp/build/output/ (twice).", ["/tmp/build/output/"]],
    ["Mounted at /Volumes/Backup/2026/", ["/Volumes/Backup/2026/"]],
    ["(the file /srv/data/export.csv)", ["/srv/data/export.csv"]],
    ["Look in /data/exports/summary.csv!", ["/data/exports/summary.csv"]],
    // Home and file URLs.
    ["Try ~/Documents/notes.txt; it is there.", ["~/Documents/notes.txt"]],
    [
      "Here: file:///Users/someone/Hub%20X/report.pdf.",
      ["file:///Users/someone/Hub%20X/report.pdf"],
    ],
    ["Here: file:///C:/Reports/report.pdf", ["file:///C:/Reports/report.pdf"]],
    // Quoted, with spaces.
    [`The deck is "/Users/someone/Hub X/deck final.pdf".`, ["/Users/someone/Hub X/deck final.pdf"]],
    ["«/home/someone/My Files/a.txt»", ["/home/someone/My Files/a.txt"]],
    // Balanced parentheses stay, the closing one of a sentence goes.
    [
      String.raw`Installed in C:\Program Files (x86)\Tool\readme.txt (see there).`,
      [String.raw`C:\Program Files (x86)\Tool\readme.txt`],
    ],
    // Two in one sentence.
    ["Compare /Users/a/one.pdf and /Users/a/two.pdf.", ["/Users/a/one.pdf", "/Users/a/two.pdf"]],
  ])("finds the path in %s", (text, expected) => {
    expect(found(text)).toEqual(expected)
  })

  it.each([
    "See https://example.com/api/users/list.json for the list.",
    "The route https://example.com/Users/someone/report.pdf is public.",
    "Call /api/v2/users to list them.",
    "Type /help or /compact.",
    "It went up 3/4 over the year.",
    "Due 2026/09/24, not 2026/10/01.",
    "Pick one and/or the other.",
    "Speed in km/h.",
    "A lone / in a sentence.",
    "Two slashes // in a comment.",
    "An email someone@example.com/x",
    "The ratio was 1/2.5 overall.",
    "relative/path/report.pdf is not absolute",
    "mailto:someone@example.com",
    // A folder with no separator at the end is not told apart from a word.
    "It is in /tmp/build/output (twice).",
  ])("finds nothing in %s", (text) => {
    expect(found(text)).toEqual([])
  })

  it("points at where each path is, for the renderer to cut", () => {
    const text = "A /Users/a/b.pdf."
    const [match] = findLocalPaths(text)
    expect(text.slice(match.start, match.end)).toBe("/Users/a/b.pdf")
    expect(match.target).toBe("/Users/a/b.pdf")
  })
})

describe("paths in delimited text (inline code, a link target, a one line block)", () => {
  it.each([
    [String.raw`C:\Users\someone\Documents\Reports\Hub X\report-2026-08.pdf`],
    ["C:/Users/someone/Hub X/deck.html"],
    ["/Users/someone/Hub X/report.pdf"],
    ["/home/someone/out"],
    ["~/Documents/My Notes/a.txt"],
    ["file:///C:/Users/someone/Hub%20X/a.pdf"],
    ["file:///home/someone/a b.pdf"],
    ["  /Users/someone/a.pdf  "],
  ])("takes %s whole", (text) => {
    expect(delimitedLocalPath(text)).toBe(text.trim())
  })

  it.each([
    ["npm run build"],
    ["/help"],
    ["/"],
    ["//server/path"],
    ["https://example.com/a.pdf"],
    [String.raw`C:\bad|name.txt`],
    [String.raw`C:\x\report.pdf:stream`],
    ["/Users/a\n/Users/b"],
    ["file:///"],
    ["Reports/report.pdf"],
    ["./out/deck.html"],
    // Routes and command lines are not files.
    ["/api/v1/threads"],
    ["/api/v2/users"],
    ["/usr/bin/env node"],
    ["/Users/someone/run --fast"],
    [String.raw`C:\tools\run --fast`],
  ])("refuses %s with no session folder", (text) => {
    expect(delimitedLocalPath(text)).toBeNull()
  })

  it("resolves a relative path against the session folder, and only then", () => {
    expect(delimitedLocalPath("Reports/report.pdf", "/Users/someone/work")).toBe(
      "/Users/someone/work/Reports/report.pdf",
    )
    expect(delimitedLocalPath("./out/deck.html", "/Users/someone/work/")).toBe(
      "/Users/someone/work/out/deck.html",
    )
    expect(delimitedLocalPath("../shared/a.txt", "/Users/someone/work")).toBe(
      "/Users/someone/work/../shared/a.txt",
    )
    expect(
      delimitedLocalPath("Rapports/Hub X/rapport.pdf", String.raw`C:\Users\someone\work`),
    ).toBe(String.raw`C:\Users\someone\work\Rapports\Hub X\rapport.pdf`)
    // Not paths, even with a folder: no extension, a fraction, a bare name,
    // an npm scope.
    for (const text of ["src/lib", "1/2.5", "package.json", "@scope/pkg.js", "and/or"]) {
      expect(delimitedLocalPath(text, "/Users/someone/work")).toBeNull()
    }
  })

  it("joins with the folder's own separator", () => {
    expect(joinLocalPath("C:\\work\\", "out/a.pdf")).toBe(String.raw`C:\work\out\a.pdf`)
    expect(joinLocalPath("/work", "./out/a.pdf")).toBe("/work/out/a.pdf")
  })
})

describe("markdown link targets", () => {
  it.each([
    ["file:///Users/someone/Hub%20X/a.pdf", null, "file:///Users/someone/Hub%20X/a.pdf"],
    // Marked hands the href URI encoded.
    ["/Users/someone/Hub%20X/a.pdf", null, "/Users/someone/Hub X/a.pdf"],
    ["C:%5CUsers%5Csomeone%5Ca.pdf", null, String.raw`C:\Users\someone\a.pdf`],
    ["out/deck.html", "/work", "/work/out/deck.html"],
  ])("opens %s", (href, base, expected) => {
    expect(localPathFromHref(href, base)).toBe(expected)
  })

  it.each([
    ["https://example.com/a.pdf"],
    ["mailto:someone@example.com"],
    ["javascript:alert(1)"],
    ["out/deck.html"],
    ["%E0%A4%A"],
  ])("leaves %s alone", (href) => {
    expect(localPathFromHref(href, null)).toBeNull()
  })
})

describe("network paths are never links", () => {
  const NETWORK = [
    String.raw`\\fileserver\team\Reports\summary.xlsx`,
    String.raw`\\attacker.example@SSL\DavWWWRoot\report.pdf`,
    String.raw`\\?\UNC\attacker.example\share\report.pdf`,
    String.raw`\\?\C:\Users\someone\report.pdf`,
    String.raw`\\.\PhysicalDrive0`,
    "//attacker.example/share/report.pdf",
    "file://attacker.example/share/report.pdf",
    "file:////attacker.example/share/report.pdf",
    String.raw`/\attacker.example\share/report.pdf`,
    "~///attacker.example/share/report.pdf",
    "file:///%5C%5Cattacker.example/share/report.pdf",
  ]

  it.each(NETWORK)("does not link %s in prose, in code or as a link target", (path) => {
    expect(found(`Saved to ${path} today.`)).toEqual([])
    expect(found(`Saved to "${path}".`)).toEqual([])
    expect(delimitedLocalPath(path)).toBeNull()
    expect(localPathFromHref(path, null)).toBeNull()
  })

  it("still links a local file URL, with or without localhost", () => {
    expect(delimitedLocalPath("file:///Users/someone/a.pdf")).toBe("file:///Users/someone/a.pdf")
    expect(delimitedLocalPath("file://localhost/Users/someone/a.pdf")).toBe(
      "file://localhost/Users/someone/a.pdf",
    )
  })
})

describe("inline code that is not a path", () => {
  it("does not link a route or a command line", () => {
    expect(delimitedLocalPath("/api/v1/threads")).toBeNull()
    expect(delimitedLocalPath("/usr/bin/env node")).toBeNull()
  })

  it("takes a folder with a space under a user's own files, and nothing command like", () => {
    for (const path of [
      String.raw`C:\Users\someone\Hub X`,
      "/Users/someone/Hub X",
      "/home/someone/Hub X",
      "/Volumes/Backup/Hub X",
      "~/Documents/Hub X",
    ]) {
      expect(delimitedLocalPath(path)).toBe(path)
    }
    for (const text of [
      "/usr/bin/env node",
      "/opt/tool/bin/run now",
      "/Users/someone/bin/tool --verbose",
      String.raw`C:\tools\run -x`,
    ]) {
      expect(delimitedLocalPath(text)).toBeNull()
    }
  })

  it("takes a path with a space when it is quoted as one", () => {
    expect(delimitedLocalPath('"/Users/someone/Hub X"')).toBe("/Users/someone/Hub X")
    expect(delimitedLocalPath("/Users/someone/Hub X/")).toBe("/Users/someone/Hub X/")
  })
})

describe("a bare path never links to a different, shorter path", () => {
  it.each([
    // Outside a user's own files a file name with a space is not told apart
    // from the words after it.
    "saved /srv/data/a b.pdf today",
    "saved /srv/data/a.b c.pdf today",
    "saved /opt/tool/report final.pdf today",
  ])("leaves %s as text", (text) => {
    expect(found(text)).toEqual([])
  })

  it.each([
    // Under a user's own files the whole name is taken, never its first word.
    [
      String.raw`saved C:\Program Files\App\report final.pdf today`,
      String.raw`C:\Program Files\App\report final.pdf`,
    ],
    ["saved ~/Documents/a b.pdf today", "~/Documents/a b.pdf"],
    ["saved /Users/someone/a b.pdf today", "/Users/someone/a b.pdf"],
    [
      String.raw`saved C:\Users\someone\Node.js Projects\a.txt today`,
      String.raw`C:\Users\someone\Node.js Projects\a.txt`,
    ],
  ])("takes %s whole", (text, expected) => {
    expect(found(text)).toEqual([expected])
  })

  it("stops at the file name instead of swallowing the words after it", () => {
    expect(found(String.raw`see C:\Users\someone\Hub X\report.pdf and more words\ here`)).toEqual([
      String.raw`C:\Users\someone\Hub X\report.pdf`,
    ])
  })

  it("takes a macOS or Linux home path with a space in a folder, whole", () => {
    expect(found("Saved to /Users/someone/Hub X/rapport.pdf today.")).toEqual([
      "/Users/someone/Hub X/rapport.pdf",
    ])
    expect(found("Saved to /home/someone/Hub X/Reports/ now.")).toEqual([
      "/home/someone/Hub X/Reports/",
    ])
    expect(found("see /Users/someone/Hub X/report.pdf and more words/ here")).toEqual([
      "/Users/someone/Hub X/report.pdf",
    ])
  })

  it("still takes two paths side by side", () => {
    expect(found("Saved /Users/a/one.pdf /Users/a/two.pdf")).toEqual([
      "/Users/a/one.pdf",
      "/Users/a/two.pdf",
    ])
  })
})

describe("a file name with spaces under a user's own files, in bare prose", () => {
  const REPORT =
    "/Volumes/Minimac/avery/Documents/Rapports Liaison/rapports/Cribbs Causeway 2026-06/2026.06_CC Cribbs Causeway - Monthly review.pdf"
  const WINDOWS_REPORT = String.raw`C:\Users\mathi\Documents\Acme\Rapports Liaison\2026.06_Centrum Handlowe Zlote Tarasy - Monthly review.pdf`

  it.each([
    // The message a local session wrote, the path on its own line after an emoji.
    [
      `✅ Rapport généré avec succès !\n\nLe rapport mensuel de juin 2026 pour CC Cribbs Causeway est prêt :\n\n📄 ${REPORT}`,
      [REPORT],
    ],
    [`📄 ${REPORT}\nIl contient 12 pages.`, [REPORT]],
    [`📄 ${WINDOWS_REPORT}\nDone.`, [WINDOWS_REPORT]],
    [`Saved to ${WINDOWS_REPORT} and emailed it.`, [WINDOWS_REPORT]],
    // It ends at the first file extension that nothing continues.
    [
      "saved to /Users/x/Hub X/report 2026-08.pdf and emailed it",
      ["/Users/x/Hub X/report 2026-08.pdf"],
    ],
    ["/Users/x/a.pdf and /Users/x/b.pdf", ["/Users/x/a.pdf", "/Users/x/b.pdf"]],
    ["/Users/x/report.pdf - done", ["/Users/x/report.pdf"]],
    [`${REPORT} - done`, [REPORT]],
    // Sentence punctuation and a closing quote are not part of it.
    [`Voici ${REPORT}.`, [REPORT]],
    [`Voici ${REPORT}, puis le reste.`, [REPORT]],
    [`(voir ${REPORT})`, [REPORT]],
    [`Il est à « ${REPORT} ».`, [REPORT]],
    [`Il est à “${REPORT}”.`, [REPORT]],
    [`Il est à ${REPORT}” donc.`, [REPORT]],
    [`(voir ${WINDOWS_REPORT})`, [WINDOWS_REPORT]],
    [`Voici ${WINDOWS_REPORT}.`, [WINDOWS_REPORT]],
    [
      "~/Rapports Liaison/2026.06_Hub X - Monthly review.pdf est prêt",
      ["~/Rapports Liaison/2026.06_Hub X - Monthly review.pdf"],
    ],
  ])("finds the whole path in %s", (text, expected) => {
    expect(found(text)).toEqual(expected)
  })

  it.each([
    // No extension before the sentence ends: it stays text.
    "Saved to /Users/x/Hub X/report, and more.pdf",
    "Saved to /Users/x/Hub X/report\nnext.pdf",
    // Outside a user's own files nothing changes.
    "Built /opt/app/2026.06_Hub X - Monthly review.pdf today",
  ])("finds nothing in %s", (text) => {
    expect(found(text)).toEqual([])
  })

  it("shows the text as written and opens the full path", () => {
    const text = `📄 ${REPORT}\nsuite`
    const [match] = findLocalPaths(text)
    expect(text.slice(match.start, match.end)).toBe(REPORT)
    expect(match.text).toBe(REPORT)
    expect(match.target).toBe(REPORT)
  })
})
