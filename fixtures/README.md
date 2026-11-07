# Shared fixtures

Every case here is run by both the TypeScript core (`@clickless/core`) and the
engine. They are what keeps the two reducers identical, so a behaviour change or
bug fix starts by adding or editing a case.

A case:

- `manifest`: name of a file in `manifests/`.
- `layout`: starting layout. Omitted means the manifest's default layout.
- `operations`: the operation list.
- `expect`: either
  - `{ "order"?, "items"?, "offScreen"? }`: the starting layout with `order`
    replaced and the listed items replaced whole. `"offScreen": null` means the
    result keeps no record of what is off screen; otherwise it is unchanged. Or
  - `{ "errors": [{ "index", "code", "message"? }] }`: validation fails and nothing
    is applied. Where `message` is given, both implementations must word the
    error exactly so.

`reconcile/` holds cases for carrying a saved layout over to a manifest: each has a
`manifest`, a `layout`, and the expected `layout` and `changes` in full.

`limits/manifests.json` holds manifests at and just past the size limits of the
grid and of a region id, components whose resize limits contradict each other
or their default size, and lists that must hold an entry they do not offer: each has a `manifest`, whether it is `accepted`, and,
for some refused ones, a `message`. The core (its schema plus
`findManifestFailure`) and the engine (its schema plus `validate_manifest`) must
agree on every one. Where `message` is given, both must refuse the manifest
past its schema, wording the error exactly so. A case refused by the schema
itself has none: the core's and the engine's schema validators each word their
errors their own way. Every case refused past the schema has one.

`contrast/cases.json` holds colours and the contrast ratio, readable text colour
and corrected text colour expected for them, which the core's `colorContrast`
and the engine's `color_contrast` must both give. Ratios are compared to one
decimal place.

Expected values are written by hand. Never paste in an implementation's output.
