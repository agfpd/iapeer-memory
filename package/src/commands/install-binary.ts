/**
 * `iapeer-memory install-binary` — compile the stable CLI binary into
 * `~/.local/bin/iapeer-memory` (init step / repair path). Must run from the
 * package SOURCE (npx / checkout); the installed binary cannot rebuild
 * itself (see binary.ts header).
 */

import { installBinary } from "../binary.js";
import type { Egress } from "../egress.js";
import { memoryPaths } from "../paths.js";

export function cmdInstallBinary(argv: string[], egress: Egress): number {
  let outPath = memoryPaths().binaryPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      const v = argv[++i];
      if (!v) {
        console.error("iapeer-memory install-binary: --out requires a value");
        return 2;
      }
      outPath = v;
    } else {
      console.error(`iapeer-memory install-binary: unknown flag: ${argv[i]}`);
      return 2;
    }
  }

  const outcome = installBinary(egress, { outPath });
  switch (outcome.action) {
    case "compiled":
      console.log(
        `install-binary: compiled ${outcome.outPath} (${Math.round(outcome.bytes / 1024 / 1024)}MB; ` +
          `signing: ${outcome.signing.state}${outcome.signing.state === "failed-soft" ? ` — ${outcome.signing.detail}` : ""})`,
      );
      return 0;
    case "skipped-compiled":
      console.error(
        "install-binary: running FROM the installed binary — sources unavailable; " +
          "re-install via: npx @agfpd/iapeer-memory install-binary",
      );
      return 1;
    case "failed":
      console.error(`install-binary: compile failed — ${outcome.detail}`);
      return 1;
  }
}
