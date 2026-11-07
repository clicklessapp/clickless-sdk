# @clickless/core

The layout format and the rules for changing it, shared by the ClickLess React
package and engine: the Zod schemas for manifests, layouts and operations, and
`validateOperations`, `applyOperations` and `reconcileLayout`. It has no React
and makes no network calls.

It is not published on its own: `@clickless/react` carries its code and types,
so applications install only that package.
