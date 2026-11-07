# ClickLess SDK

ClickLess lets the users of an application shape its interface and use its
features by asking in plain words, typed or spoken.

It does two things:

- **Reshape the interface.** Users rearrange dashboards, hide sections, choose
  which table columns show, change colours or adjust text size. Each change is
  previewed before it is kept, can be undone, and is saved for that user alone.
- **Carry out actions.** Users ask for what the application already offers,
  from reaching a screen buried several menus deep to "show this week's unpaid
  invoices", "sort orders by delivery date" or "cancel my 3pm booking". Actions
  you mark as only changing what is shown, such as opening a page, searching,
  filtering or sorting, happen at once. Actions that change data wait for the
  user to confirm.

You declare which parts of each screen may change and how, and which actions
users may run. The ClickLess engine turns each request into a list of
operations and checks every one against your declarations. It never generates
or runs code of its own, so nothing happens that you haven't allowed. If the
engine can't be reached, your application keeps working exactly as you built
it.

Requests your application can't fulfil yet are recorded for your team, so you
can see what users ask for.

This repository holds the code that runs in your application:

| Path | What it is |
| --- | --- |
| [`packages/react`](packages/react) | `@clickless/react`, the SDK for React applications and the package you install. Its [README](packages/react/README.md) is the full guide. |
| [`packages/core`](packages/core) | The layout format and the rules for changing it, with no React and no network calls. `@clickless/react` carries it. |
| [`schemas`](schemas) | The JSON Schema for manifests, layouts and operations, shared with the ClickLess engine. |
| [`fixtures`](fixtures) | Cases the core and the engine both run, so the two always agree. |

The engine, the service that turns a request into changes, is not in this
repository.

## Install

```bash
npm install @clickless/react
```

React 18 or later is required. See [packages/react/README.md](packages/react/README.md)
to get started.

## Working on the SDK

With Node.js 24 and pnpm:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

`pnpm gen` regenerates `packages/core/src/schemas.gen.ts` from
`schemas/clickless.schema.json`.

## Contributing

This repository is published from the main ClickLess repository, where the SDK
is developed alongside the engine. Issues and pull requests are welcome here. An
accepted pull request is applied there, with you credited as its co-author, and
arrives back here with the next update, so it is closed rather than merged.

To report a security problem, use this repository's private vulnerability
reporting (Security, then Report a vulnerability) rather than an issue.

## License

[MIT](LICENSE)
