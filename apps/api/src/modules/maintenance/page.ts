// SPDX-License-Identifier: FSL-1.1-ALv2
import { escapeHtml } from "~/lib/html-page"

export function maintenancePage(targetVersion?: string): string {
  const version = targetVersion
    ? `<p>Upgrading to <code>${escapeHtml(targetVersion)}</code>.</p>`
    : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Liaison is upgrading</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #fafafa; color: #1a1a1a; }
  main { max-width: 36rem; margin: 6rem auto; padding: 2rem; background: #fff; border-radius: 0.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h1 { margin-top: 0; font-size: 1.5rem; }
  p { margin: 0.75rem 0; line-height: 1.5; }
  code { background: #f0f0f0; padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-size: 0.9em; }
</style>
</head>
<body>
<main>
  <h1>Liaison is upgrading</h1>
  <p>We're applying a release. This usually takes a couple of minutes.</p>
  ${version}
  <p>This page will reconnect automatically when the upgrade finishes.</p>
</main>
<script>setTimeout(() => location.reload(), 10000)</script>
</body>
</html>`
}
