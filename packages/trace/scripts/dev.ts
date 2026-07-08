import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const viteArgs: string[] = [];
let home: string | undefined;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--home") {
    const value = args[index + 1];
    if (!value) {
      throw new Error("Missing value for --home.");
    }
    home = value;
    index += 1;
    continue;
  }
  if (arg?.startsWith("--home=")) {
    home = arg.slice("--home=".length);
    continue;
  }
  if (arg) {
    viteArgs.push(arg);
  }
}

const require = createRequire(import.meta.url);
const vitePackageJson = require.resolve("vite/package.json");
const viteBin = path.join(path.dirname(vitePackageJson), "bin", "vite.js");
const child = spawn(process.execPath, [viteBin, ...viteArgs], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...(home ? { GESTALT_HOME: home } : {})
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
