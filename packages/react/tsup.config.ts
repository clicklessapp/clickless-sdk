import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // Core's code is carried in this package, so it installs without a second one.
  external: ["react", "zod"],
  noExternal: ["@clickless/core"],
  banner: { js: '"use client";' },
  // Sent to the engine with every request, so its log can say which build of
  // the SDK made a request it could not read.
  define: { __CLICKLESS_VERSION__: JSON.stringify(version) },
});
