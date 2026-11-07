// The top of the repository: the folder holding the schema and fixtures that
// the core and the engine share. Found by looking up from here rather than by
// a fixed path, as the packages sit at a different depth in the SDK's own
// repository.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function findRepositoryRoot() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "schemas", "clickless.schema.json"))) {
    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) throw new Error("No schemas/clickless.schema.json above this package.");
    directory = parentDirectory;
  }
  return directory;
}
