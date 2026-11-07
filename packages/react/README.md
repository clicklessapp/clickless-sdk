# @clickless/react

Let the users of your React application shape its interface and use its
features by asking in plain words, typed or spoken:

- **Reshape the interface.** Users rearrange dashboards, hide sections, choose
  which table columns show, change colours or adjust text size. Each change is
  previewed before it is kept, can be undone, and is saved for that user alone.
- **Carry out actions.** Users ask for what your application already offers:
  "show this week's unpaid invoices", "change my name to Joshua". Actions you
  mark as only changing what is shown happen at once; actions that change data
  wait for the user to confirm.

You declare which parts of a screen may change and how, and which actions users
may run. Every proposal is checked against your declarations before anything
is shown, saved or run, and if the ClickLess engine can't be reached, your
application keeps working as you built it.

## Install

```bash
npm install @clickless/react
```

React 18 or later is required. This one package is all you need. Until version
1.0, a minor version (0.1 to 0.2) may change the API, and the release notes say
what to change.

## Quick start

Mark the sections users may change, and add the prompt panel:

```tsx
import { Adaptive, AdaptiveProvider, AdaptiveRegion, PromptPanel, propPresets } from "@clickless/react";

<AdaptiveProvider userId={currentUser.id} engine={{ url: "https://clickless.example.com", getToken }}>
  <AdaptiveRegion id="dashboard" version="1">
    <Adaptive
      id="revenue"
      kind="chart"
      title="Revenue by month"
      defaults={{ w: 6, h: 3 }}
      presets={{
        months: propPresets.count({ max: 12, initial: 6 }),
        chartType: propPresets.choice({ values: ["bar", "line"], initial: "bar", means: "the kind of chart" }),
      }}
    >
      {(props, adaptiveControls, presetValues) => <RevenueChart type={presetValues.chartType} months={presetValues.months} />}
    </Adaptive>
    <Adaptive id="txns" kind="table" title="Recent transactions" defaults={{ w: 6, h: 3 }}>
      <TransactionsTable />
    </Adaptive>
  </AdaptiveRegion>
  <PromptPanel regionId="dashboard" />
</AdaptiveProvider>
```

Users can now ask "put the transactions first", "make the revenue chart a line
chart" or "show the last 12 months".

Moving and hiding need nothing from your components: `TransactionsTable` is
wrapped as it is. A setting such as `chartType` is handed to your code as a
value, to pass on to a prop your component already has.

Offer an action the same way, with a function that does it as your own screens
would:

```tsx
import { ActionError, useAdaptiveAction } from "@clickless/react";

useAdaptiveAction({
  name: "updateName",
  title: "Change your name",
  description: "Changes the signed-in user's first name, last name, or both.",
  parameters: {
    firstName: { type: "text", description: "First name", required: false },
    lastName: { type: "text", description: "Last name", required: false },
  },
  run: async (changes) => {
    const response = await fetch("/api/me", { method: "PATCH", body: JSON.stringify(changes) });
    if (!response.ok) throw new ActionError("Your name couldn't be changed just now.");
    return "Your name has been changed.";
  },
});
```

"Change my name to Joshua" now asks the user to confirm, then runs it.

`getToken`, passed to `AdaptiveProvider` above, returns a short-lived token that
your own backend signs for the signed-in user. The guide's
[Connecting to the engine](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#connecting-to-the-engine)
shows how to sign one.

## Learn more

The [full guide](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md)
covers everything you can declare:

- [Choosing what users can change](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#choosing-what-users-can-change):
  moving, hiding, resizing, and settings such as colours, columns and text size
- [Doing things for the user: actions](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#doing-things-for-the-user-actions):
  parameters, confirmation, actions that only change what is shown, errors
- [What the AI model sees](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#what-the-ai-model-sees)
- [Connecting to the engine](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#connecting-to-the-engine):
  tokens, and what happens when ClickLess is unavailable
- [Fitting a region to the page's own layout](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#fitting-a-region-to-the-pages-own-layout)
  and [a screen made of several regions](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#a-screen-made-of-several-regions)
- [The prompt panel](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#the-prompt-panel),
  [speaking a request](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#speaking-a-request)
  and [building your own controls](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#building-your-own-controls)
- [When your screens change](https://github.com/clicklessapp/clickless-sdk/blob/main/packages/react/GUIDE.md#when-your-screens-change)

## License

MIT
