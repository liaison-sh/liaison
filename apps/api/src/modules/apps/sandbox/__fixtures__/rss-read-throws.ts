// SPDX-License-Identifier: FSL-1.1-ALv2
// Preload for sandbox-worker-rss.test.ts: this process's own RSS read fails
// the way Bun's process.memoryUsage.rss() does now and then.
process.memoryUsage.rss = () => {
  throw new Error("Failed to get memory usage")
}
