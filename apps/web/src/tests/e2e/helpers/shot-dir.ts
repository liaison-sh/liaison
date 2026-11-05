// SPDX-License-Identifier: FSL-1.1-ALv2
// Where the phone scenarios drop their walk screenshots (evidence for a human
// reviewing the layout, not baselines). It was a hard-coded per-machine temp
// path that exists on one developer's Mac only, so every phone scenario failed
// with ENOENT anywhere else. PW_SHOT_DIR overrides; the default is under the
// OS temp dir, created on first use.
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export const SHOT_DIR = process.env.PW_SHOT_DIR ?? path.join(tmpdir(), "liaison-phone-shots")
mkdirSync(SHOT_DIR, { recursive: true })
