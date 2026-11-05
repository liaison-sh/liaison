// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Installs the catalog apps the timing spike's world uses into the instance the
// environment points at (the spike's second and third databases), in a child
// process so each instance keeps its own database and apps directory.
import { installFromDist } from "../seed/install-dist-apps"

for (const app of process.argv.slice(2)) await installFromDist(app, crypto.randomUUID())
process.exit(0)
