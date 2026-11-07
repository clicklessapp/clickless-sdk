// Copies @clickless/core's type declarations into dist/core and points this
// package's declarations at them, so the package installs on its own: its
// JavaScript already carries core's code (see tsup.config.ts).
// Run after `tsc -p tsconfig.build.json`. The build script builds @clickless/core
// first, so the declarations copied match the core code bundled by tsup.
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const distDirectory = join(packageDirectory, "dist");
const coreTypesDirectory = join(packageDirectory, "..", "core", "dist");
const bundledCoreDirectory = join(distDirectory, "core");

if (!existsSync(join(coreTypesDirectory, "index.d.ts"))) {
  throw new Error("Build @clickless/core first: its type declarations are copied into this package.");
}
cpSync(coreTypesDirectory, bundledCoreDirectory, {
  recursive: true,
  filter: (path) => !path.endsWith(".js"),
});

const declarationFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return path === bundledCoreDirectory ? [] : declarationFiles(path);
    return path.endsWith(".d.ts") ? [path] : [];
  });

for (const declarationFile of declarationFiles(distDirectory)) {
  const declarations = readFileSync(declarationFile, "utf8");
  let pathToCore = relative(dirname(declarationFile), join(bundledCoreDirectory, "index.js"));
  if (!pathToCore.startsWith(".")) pathToCore = `./${pathToCore}`;
  const rewritten = declarations.replaceAll('"@clickless/core"', JSON.stringify(pathToCore));
  if (rewritten !== declarations) writeFileSync(declarationFile, rewritten);
}
