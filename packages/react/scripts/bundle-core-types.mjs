// Copies @clickless/core's type declarations into dist/core and points this
// package's declarations at them, so the package installs on its own: its
// JavaScript already carries core's code (see tsup.config.ts).
//
// It also gives every relative import in the declarations an explicit `.js`
// path. tsc writes them as the source has them (`./core/index`, `./schemas.gen`),
// which bundler resolution accepts but Node's node16/nodenext resolution, used
// by many TypeScript servers and SSR setups, rejects.
//
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
    if (entry.isDirectory()) return declarationFiles(path);
    return path.endsWith(".d.ts") ? [path] : [];
  });

// `from "./x"`, `import("./x")` and `import "./x"`, with either quote.
const relativeSpecifier = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?(?:\/[^"']*)?)\2/g;

const withJsPath = (declarationFile, specifier) => {
  if (specifier.endsWith(".js")) return specifier;
  const target = join(dirname(declarationFile), specifier);
  if (existsSync(`${target}.d.ts`)) return `${specifier}.js`;
  if (existsSync(join(target, "index.d.ts"))) return `${specifier.replace(/\/$/, "")}/index.js`;
  throw new Error(`${relative(distDirectory, declarationFile)} imports "${specifier}", which has no declarations in dist.`);
};

for (const declarationFile of declarationFiles(distDirectory)) {
  const declarations = readFileSync(declarationFile, "utf8");
  let pathToCore = relative(dirname(declarationFile), join(bundledCoreDirectory, "index.js"));
  if (!pathToCore.startsWith(".")) pathToCore = `./${pathToCore}`;
  const rewritten = declarations
    .replaceAll('"@clickless/core"', JSON.stringify(pathToCore))
    .replace(relativeSpecifier, (_, lead, quote, specifier) =>
      `${lead}${quote}${withJsPath(declarationFile, specifier)}${quote}`);
  if (rewritten !== declarations) writeFileSync(declarationFile, rewritten);
}
