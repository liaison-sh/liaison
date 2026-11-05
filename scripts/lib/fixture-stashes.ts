// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Abandoned fixture stashes, reported to the operator running `db-reset`.
 *
 * `takeOverAppSchema` (apps/api/src/tests/helpers) parks a registered app
 * schema under `<app>__fixture_stash_<run>` for the lifetime of one test file,
 * leaving its own fixture standing in for the real schema. A run killed between
 * take-over and release never puts the original back, and a database in that
 * state is exactly what an operator reaches for `db-reset` to clear.
 *
 * The reset used to DROP those schemas in a `DO` block. That was dead weight:
 * `DROP DATABASE` three statements later takes them with everything else. Worse,
 * the `RAISE WARNING` naming each one went to psql's stderr, which the script
 * read only when psql exited non-zero, so the operator was never told. The list
 * is what carries the information, so it is a plain SELECT and it is printed.
 */

/** Every stash schema in the database, whoever minted it. */
export const ABANDONED_STASH_QUERY =
  "SELECT nspname FROM pg_namespace " +
  "WHERE nspname LIKE '%\\_\\_fixture\\_stash\\_%' ESCAPE '\\' ORDER BY nspname"

/**
 * Turn `psql -t -A` output for the query above into the lines the reset prints,
 * or `null` when the database is clean and there is nothing to say.
 */
export function formatAbandonedStashReport(psqlOutput: string): string | null {
  const names = psqlOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (names.length === 0) return null
  const noun = names.length === 1 ? "stash" : "stashes"
  return [
    `Found ${names.length} abandoned fixture ${noun} before the drop:`,
    ...names.map((name) => `  ${name}`),
    "A test run was killed between take-over and release, so the schema under " +
      "the real name was that run's fixture, not the app's own.",
  ].join("\n")
}
