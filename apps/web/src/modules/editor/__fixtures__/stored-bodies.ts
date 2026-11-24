// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Page bodies as Knowledge stores them, one per construct the reader draws, alone and
// in pairs: 200 in all. The page editor must open and close each without writing a
// byte, and keep every block it was not asked to change.

/** One construct each; ids name them in a failing test. */
export const CONSTRUCTS: ReadonlyArray<readonly [string, string]> = [
  ["heading", "# Return policy\n\n## Who decides\n\n### Steps"],
  ["setext", "Return policy\n=============\n\nWho decides\n-----------"],
  ["paragraph", "Customers may return an item within 30 days of delivery."],
  ["emphasis", "This is **bold**, _italic_, ~~struck~~ and `code` text."],
  ["underline", "A ++underlined++ word."],
  ["bullet-tight", "- one\n- two\n- three"],
  ["bullet-loose", "- one\n\n- two\n\n- three"],
  ["nested", "1. first\n   - inner a\n   - inner b\n2. second"],
  ["tasks", "- [ ] check the box\n- [x] ship it"],
  ["table", "| Plan | Price |\n| --- | --- |\n| Base | 29 |\n| Team | 99 |"],
  ["table-verbatim", "| a | b |\n| - | - |\n| ![x](https://example.com/x.png) | 2 |"],
  ["code-fence", "```ts\nconst a = 1\nconsole.log(a)\n```"],
  ["quote", "> A quote\n> on two lines"],
  ["html-block", "<details>\n<summary>More</summary>\n\nHidden text\n\n</details>"],
  ["html-inline", "A <kbd>Ctrl</kbd> key and a <reason>tag</reason>."],
  ["ref-link", "See [the docs][docs].\n\n[docs]: https://example.com/docs"],
  ["entities", "Fish &amp; chips &copy; 2026 &lt;tag&gt;"],
  ["hard-break", "Line one  \nline two\\\nline three"],
  ["crlf", "First line\r\nsecond line\r\n\r\nNext paragraph"],
  ["trailing-spaces", "Words with trailing spaces   \n\nAnd more"],
  ["mention", "Ask @[Amina Cherif](kernel:user:6f1c2a90-3b1d-4c2e-9f00-1a2b3c4d5e6f) first."],
  ["image", "Logo: ![logo](https://example.com/logo.png) here."],
  ["page-link", "See [](knowledge:document:0b9a3c5e-1d2f-4a6b-8c7d-9e0f1a2b3c4d) for more."],
  ["footnote-like", "A claim[^1].\n\n[^1]: The source."],
  ["emoji", "Done 🎉 and :smile: too."],
  ["rule", "Above\n\n---\n\nBelow"],
  ["autolink", "Visit https://example.com/path?a=1 or <https://example.com>."],
  ["escapes", "Not \\*bold\\*, a \\_name\\_ and 1\\. item"],
]

function pairs(): string[] {
  const out: string[] = []
  for (let i = 0; i < CONSTRUCTS.length; i++)
    for (let j = i + 1; j < CONSTRUCTS.length; j++)
      out.push(`${CONSTRUCTS[i]![1]}\n\n${CONSTRUCTS[j]![1]}`)
  return out
}

/** 200 stored bodies: every construct alone, then pairs. */
export const STORED_BODIES: string[] = [...CONSTRUCTS.map(([, body]) => body), ...pairs()].slice(
  0,
  200,
)
