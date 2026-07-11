import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const outdir = path.join(packageRoot, "dist");
const traceRoot = path.resolve(packageRoot, "../trace");
const traceDist = path.join(traceRoot, "dist");

await rm(outdir, { recursive: true, force: true });
await requireTraceBuild(traceDist);
await cp(traceDist, path.join(outdir, "live-ui"), { recursive: true });
await build({
  entryPoints: [path.join(packageRoot, "src", "main.ts")],
  outfile: path.join(outdir, "main.js"),
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  logLevel: "info"
});

async function requireTraceBuild(directory) {
  try {
    const index = await stat(path.join(directory, "index.html"));
    if (index.isFile()) {
      return;
    }
  } catch {
    // Report the workspace-level command below.
  }
  throw new Error(
    "Trace UI is not built. Run `pnpm run build` from the workspace root."
  );
}
