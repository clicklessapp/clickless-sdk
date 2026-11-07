import { join } from "node:path";
import { findRepositoryRoot } from "../scripts/repositoryRoot.mjs";

/** The fixtures shared with the engine, ending in a slash so a file's path can be added to it. */
export const fixturesDirectory = join(findRepositoryRoot(), "fixtures") + "/";
