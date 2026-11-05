-- SPDX-License-Identifier: FSL-1.1-ALv2
--
-- Numbering-invariant SQL check.
--
-- For every (issuer_profile_id, type, year_of_issue) tuple with at least
-- one issued document, finds any integer in the range [min_number, max_number]
-- that has no corresponding document row. A missing number is a real sequence
-- gap and violates the EU legal requirement of gapless invoice numbering
-- (spec §"Issuing & Numbering").
--
-- Unlike the simpler MAX - COUNT heuristic, this uses generate_series /
-- EXCEPT to enumerate the expected sequence and subtract the actual one,
-- so it detects non-terminal gaps (e.g. a deleted middle row whose slot
-- was not reused) that the heuristic misses when an equal number of later
-- documents exist.
--
-- Usage:
--   psql $DATABASE_URL -f bundled-apps/invoicing/scripts/check-numbering.sql
--
-- Exit non-zero from the test runner if any row is returned.
WITH series AS (
  SELECT
    issuer_profile_id,
    type,
    year_of_issue,
    MIN(number_int) AS min_number,
    MAX(number_int) AS max_number
  FROM app_invoicing.documents
  WHERE number_int IS NOT NULL
  GROUP BY issuer_profile_id, type, year_of_issue
),
expected AS (
  SELECT
    s.issuer_profile_id,
    s.type,
    s.year_of_issue,
    g.n AS expected_number
  FROM series s
  CROSS JOIN LATERAL generate_series(s.min_number, s.max_number) AS g(n)
),
actual AS (
  SELECT issuer_profile_id, type, year_of_issue, number_int AS actual_number
  FROM app_invoicing.documents
  WHERE number_int IS NOT NULL
)
SELECT
  e.issuer_profile_id,
  e.type,
  e.year_of_issue,
  e.expected_number AS missing_number
FROM expected e
WHERE NOT EXISTS (
  SELECT 1 FROM actual a
  WHERE a.issuer_profile_id = e.issuer_profile_id
    AND a.type             = e.type
    AND a.year_of_issue    = e.year_of_issue
    AND a.actual_number    = e.expected_number
)
ORDER BY e.issuer_profile_id, e.type, e.year_of_issue, e.expected_number;
