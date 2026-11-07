# @clickless/react guide

Everything you can declare and how it behaves. For what ClickLess is and the
shortest way to get started, see the [README](README.md).

- [Install](#install)
- [Quick start](#quick-start)
- [Choosing what users can change](#choosing-what-users-can-change)
- [Doing things for the user: actions](#doing-things-for-the-user-actions)
- [Connecting to the engine](#connecting-to-the-engine)
- [Fitting a region to the page's own layout](#fitting-a-region-to-the-pages-own-layout)
- [A screen made of several regions](#a-screen-made-of-several-regions)
- [The prompt panel](#the-prompt-panel)
- [Speaking a request](#speaking-a-request)
- [Building your own controls](#building-your-own-controls)
- [When your screens change](#when-your-screens-change)

## Install

```bash
npm install @clickless/react
```

This one package is all you need: it carries `@clickless/core`'s code and
types, and re-exports the format's types (`Layout`, `Operation`,
`PropCapabilities` and the rest). React 18 or later is required, and its only
other dependency is `zod`.

Until version 1.0, a minor version (0.1 to 0.2) may change the API, and the
release notes say what to change.

## Quick start

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

- **`AdaptiveProvider`** connects the page to the ClickLess engine, which stores
  each user's layout and plans changes from prompts. `userId` is whoever is
  signed in: the user id your backend puts in the token's `sub`. When it
  changes, as when someone signs out and another signs in on a shared
  computer, everything inside the provider is mounted afresh, so the next user
  never sees what the last one typed. A request is sent only with a token for
  `userId`, so nothing the last user left unsaved is saved to the next one's
  account, wherever in your application they land. The same holds for the
  tenant of the first token the provider sends: where someone can switch
  tenant without a reload, give the provider the tenant as its `key`. A
  `userId` that is not the token's `sub` sends nothing at all, and says so in
  the browser console. A region shows its default
  until its saved layout arrives; list in `preloadRegions` any that mount late,
  such as a sidebar a phone draws only once its menu opens, and they are read
  up front so they show the saved layout at once. Regions, sections,
  `AdaptiveAction`, `useAdaptiveRegion` and `useAdaptiveAction` also work
  outside the provider,
  as in your own tests or stories: regions show their defaults, nothing is
  saved, no action is offered, and the browser console says so once.
  `useAdaptiveRegion` then reads the region it sits in; outside that region
  too, it reads an empty one of its own. `PromptPanel`,
  `PromptBar`, `usePromptBar`, `useChangeHistory` and `useDictation` still
  need the provider, since they have nothing to offer without it.
- **`AdaptiveRegion`** is one part of a screen whose sections can be rearranged.
  Its `id` is what each user's layout is saved under.
- **`Adaptive`** wraps one section. `title` is what users call it; the model
  uses it to know which section "the revenue chart" means, and the panel uses it
  in what it says. Without one the model is given the `id`, and the panel,
  which never shows users an id, speaks of "a section".
- **`PromptPanel`** is the button and panel where users ask for changes.

## Choosing what users can change

Everything a user can change about a section is declared on its `Adaptive`.
What is not declared cannot be changed: a request for it is refused, and the
panel's reply says, in plain words, that it cannot be done.

| To let users | Declare | On by default |
|---|---|---|
| Move it among the other sections | `capabilities={{ move: true }}` | yes |
| Hide it and show it again | `capabilities={{ hide: true }}` | yes |
| Make it wider, narrower, taller or shorter | `capabilities={{ resize: { minW, maxW, minH, maxH } }}` | no |
| Change a setting of it, such as a colour | `presets={{ … }}` ([below](#settings-built-in-and-custom)) | no |

Moving and hiding are on unless you turn them off, so an `Adaptive` with no
`capabilities` at all can already be moved and hidden. (In a region drawn with
`grid={false}`, only sections in a `group` can be moved; see
[below](#fitting-a-region-to-the-pages-own-layout).) To stop either, say so:

```tsx
<Adaptive id="balance" title="Account balance" capabilities={{ move: false, hide: false }}>
```

`locked` turns off every change at once. Showing is not a separate capability:
a hidden section can always be shown again.

### Resizing

Sizes are counted in the region's grid: `w` in columns (12 across by default)
and `h` in rows. Give the starting size in `defaults` and the limits in
`resize`:

```tsx
<Adaptive
  id="pipeline"
  title="Sales pipeline"
  capabilities={{ resize: { minW: 4, maxW: 12, minH: 2, maxH: 6 } }}
  defaults={{ w: 8, h: 4 }}
>
```

### Settings: built-in and custom

A setting is anything about a section you are willing to let users choose: a
chart type, the columns a table shows, an accent colour, a font size. You
declare each one in `presets`, under a name of your choosing, and read its
current value from the render function's third argument, under the same name
and already of the right type. ClickLess stores the value and hands it to you;
**what it changes on screen is up to you**, since ClickLess cannot reach inside
your component.

Each setting brings its starting value and a sentence telling the model what it
means, so a request in the user's own words ("tighter rows", "show 6 months")
lands on the right setting.

**Use a built-in setting when one fits.** Its name, values and wording are the
same in every application, and tested:

| Setting | Lets users change | You receive |
|---|---|---|
| `count({ max, initial, min?, of? })` | how many entries show | a number |
| `highlight({ top?, above?, below?, kinds?, entries?, colour?, suggested? })` | which entries stand out: the top few (such as the top 3), those above or below an amount (such as over £1,000, or due before 2 pm), or those of chosen kinds (such as cancelled orders) | `styleFor(position, value)`, a style for each entry; also `isHighlighted`, `colour`, `textColour` |
| `density({ initial? })` | how tightly rows sit | `"comfortable"` or `"compact"` |
| `stripes({ suggested?, textOn?, against? })` or `stripes({ palette })` | colouring every other row | `{ colour, textColour }`, or `null` when off |
| `colours({ background?, textColour?, suggested? })` | the background and text colour | `style`, both as a style; also `background`, `textColour`, `chosenTextColour` |
| `textSize({ min?, max?, initial? })` | the size of the text, in pixels | a number |
| `textStyle({ initial? })` | bold, italic, both or neither | `{ bold, italic }` |
| `accent({ marks, colour?, suggested?, textOn?, against? })` | the colour that marks what stands out, such as today or the primary buttons | `{ colour, textColour }` |

```tsx
<Adaptive
  id="txns"
  title="Recent transactions"
  defaults={{ w: 12, h: 4 }}
  presets={{
    count: propPresets.count({ min: 3, max: 25, initial: 8 }),
    rows: propPresets.density(),
    highlight: propPresets.highlight({ above: { measure: "amount in pounds" } }),
  }}
>
  {(props, adaptiveControls, presetValues) => (
    <TransactionsTable
      rowCount={presetValues.count}
      compact={presetValues.rows === "compact"}
      rowStyle={(rowIndex, transaction) => presetValues.highlight.styleFor(rowIndex, transaction.amount)}
    />
  )}
</Adaptive>
```

`count`'s `of` and `highlight`'s `entries` name what is counted or highlighted,
in the plural, where the section's `title` does not make it plain. `highlight`'s
`above.measure` and `below.measure` say what is compared, with its unit and
without "the", since "over 1,000" means nothing on its own. A time of day is a
number too: "due time in hours from midnight, such as 13.5 for 1:30 pm", with
`max: 24`, lets users colour what is due before 2 pm. `above` and `below`
compare the same value, so given together they name the same measure. No
highlight has an upper limit unless you give `max`, so it suits a list whose
contents change.

`highlight`'s `kinds` colours the entries of the kinds users choose, from a
fixed set you name: `kinds: { of: "statuses", values: ["placed", "shipped",
"cancelled"] }`. Give each entry's kind where you would give its amount,
`styleFor(rowIndex, { kind: order.status })`, or both,
`styleFor(rowIndex, { measure: hours, kind: order.status })`; an entry is
coloured when any rule in use holds. The values are kinds an entry falls into,
such as a status, a priority or a category, never the entries themselves: a
person's or a customer's name is never one, so no one's name is sent to the
engine or kept in a layout.

A built-in setting's props keep their shared names (`density`, `stripes`)
whatever you file it under.

**Start with the props your components already have.** Most settings are one
value for the whole section, a number, a word or a colour, and go straight into a
prop the component already takes (`type`, `variant`, `pageSize`) or into `style`,
so the component itself does not change. Where a setting decides something for
each entry, as `highlight` does, it hands you a ready `style` for each one, to
pass to the entry's own `style`:

```tsx
<tr style={presetValues.highlight.styleFor(rowIndex, transaction.amount)}>
```

The value you pass, here `transaction.amount`, is the one `measure` describes:
the setting stores only the amount the user asked for, and compares it with what
you give it.

**Otherwise, a custom setting**, for what only your application knows: its own
views, its columns, its colours. You give the values and a few plain words saying
what the setting means, in `means` (or `shows`), and the setting takes the name
you file it under.

**On or off**, for showing or hiding one part:

```tsx
presets={{ trend: propPresets.toggle({ shows: "the line comparing it with last month" }) }}
// presetValues.trend is true or false
```

**One choice from a list**, such as a chart type:

```tsx
presets={{
  chartType: propPresets.choice({
    values: ["bar", "line", "area"],
    initial: "bar",
    means: "the kind of chart",
  }),
}}
// presetValues.chartType is "bar" | "line" | "area"
```

A request for something that is not listed ("make it a pie chart") is answered
with the closest listed option, where one is a sensible stand-in, and the reply
says which was used. Where none is, the reply names the options there are.

**Several entries, in order**, such as the columns a table shows. `min` is the
fewest entries allowed, and `initial` the ones that show to begin with (all of
them unless given):

```tsx
presets={{
  columns: propPresets.visibleList({
    values: ["date", "payee", "category", "amount"],
    initial: ["date", "payee", "amount"],
    min: 1,
    means: "the columns that show, left to right",
  }),
}}
// presetValues.columns is the list, in the order to show it
```

The value is the list, in the order to show it, so hiding, showing and
reordering columns are all one kind of change. A column you add to `values` in
a later release, and include in `initial`, appears for existing users too; one
a user removed stays removed.

`required` lists entries the list must always hold. They can be moved but never
left out, and one missing from a saved layout goes back in beside its neighbour
in `initial`, or at the end if `initial` does not list it. The value may change
from render to render, such as keeping the tab of the page that is open, so the
user always has a way back to it:

```tsx
pages: propPresets.visibleList({
  values: Object.keys(PAGES),
  min: 1,
  required: [currentPageKey],
  means: "the tabs that show, left to right",
}),
```

Say why in `description`, so a request to hide it is declined with a reason.

**A colour.** Any colour is accepted, written as `#rrggbb`. `suggested` lists
your own brand colours, which the model prefers when the user names none ("use
one of our colours"); it does not restrict the user:

```tsx
presets={{
  barColour: propPresets.colour({
    initial: "#1c5cab",
    suggested: ["#1c5cab", "#0f766e", "#b45309"],
    means: "the colour of the bars",
  }),
}}
```

**Text drawn on a chosen colour.** Every setting that hands you a chosen colour
also hands you the text colour to draw on it, worked out for you: `accent`,
`colour` and `stripes` read as `{ colour, textColour }`, where `textColour` is
black or white, whichever reads better on `colour`. `highlight` gives
`textColour` too, and `colours` keeps the text colour the user chose where it
reads on the background and turns it black or white where it does not.

Give `textOn: true` where you draw text on the colour in `textColour`, such as
a button's label. The model is then told the text stays readable, and when a
chosen colour turns it from white to black or back, the reply says so: "White
text is hard to read on orange, so I've made it black." Give `against` for the
colour behind it, such as the page's, and the reply says when a chosen colour
would be hard to see there: white buttons on a white page, or a yellow link
colour on white.

```tsx
<Adaptive id="primary-buttons" title="Primary buttons"
  presets={{ accent: propPresets.accent({ marks: "the primary buttons", textOn: true }) }}>
  {(props, adaptiveControls, { accent }) => (
    <Button style={{ background: accent.colour, color: accent.textColour }}>Save</Button>
  )}
</Adaptive>
```

For a colour you pair with text yourself, `readableTextColor(background)`
returns black or white for it, and `ensureReadableTextColor(text, background)`
keeps a text colour the user chose only where it is readable on that background,
falling back to black or white.

**A number in a range**, such as a corner radius. Numbers are whole unless you
pass `whole: false`. A request past either end is brought to that end, and the
reply says so:

```tsx
presets={{
  corners: propPresets.number({ min: 0, max: 24, initial: 6, means: "the corner radius in pixels" }),
}}
```

If a custom setting you need keeps coming up, tell us: settings that recur
across applications are made built-in.

### What gets refused

Every change is checked against the declarations before it is previewed or
saved, by the library in the browser and again by the engine:

| A request to… | Is refused because |
|---|---|
| change a setting the section never declared | no setting in `presets` has that name |
| set a value the setting does not allow (an unlisted option, a number out of range, a colour not written `#rrggbb`) | it is checked against the setting's kind |
| resize a section with no `resize` limits, or past them | resizing was not declared, or the size is out of range |
| move or hide a section with `move: false` or `hide: false` | that capability is off |
| change a `locked` section in any way | it is locked |
| hide the last section showing in a region | a region always keeps something showing |

Users never see these rules or their codes. The model plans only within what
you declared, and when part of a request is outside it, the reply says what
could not be done and the rest goes ahead. A request that could not be carried
out is also recorded for your team, so you can
see which settings users ask for that you do not offer yet.

A region always keeps at least one section showing, so no request empties a
page. Where a region has sections with a size, only those count: buttons, menus
and tabs, which the page sizes itself, do not keep a page of cards and charts
from looking empty, though the last section of any kind stays too. "Hide
everything on this page" hides all but the first of them and the reply says
which one stayed and that "show everything" brings the rest back; with a sidebar
on the same screen, each region keeps one. The same change through
`applyOperations` is refused with the code `empty_region`. Nothing has to be
declared for this. A region that shows nothing by default may be left showing
nothing. The prompt panel is not a section, so it stays on screen to bring
everything back.

Declarations are what users may change, not a security boundary: the engine
checks a change against the manifest sent with it, which comes from the
browser.

## Doing things for the user: actions

Besides reshaping a screen, the panel can do things for the user that your
application already does: change their name, upload a profile picture, open a
customer's record. You offer each one as an action, with a function that does it
the way your own screens would:

```tsx
import { ActionError, useAdaptiveAction } from "@clickless/react";

useAdaptiveAction({
  name: "updateName",
  title: "Change your name",
  description: "Changes the signed-in user's first name, last name, or both. Give only what changes.",
  parameters: {
    firstName: { type: "text", description: "First name", required: false },
    lastName: { type: "text", description: "Last name", required: false },
  },
  confirm: ({ firstName, lastName }) => `Change your name to ${firstName} ${lastName}?`,
  run: async (changes) => {
    const response = await fetch("/api/me", { method: "PATCH", body: JSON.stringify(changes) });
    if (!response.ok) throw new ActionError("Your name couldn't be changed just now.");
    return "Your name has been changed.";
  },
});
```

A user then asks, in words or by voice: "update my first name to Joshua and my
last name to King".

- **`run` makes the request, in the browser.** It goes out with the user's own
  sign-in, so your backend's permissions and rules apply exactly as they do for
  your own forms. ClickLess never holds credentials for your API and never
  calls it.
- **Changes are confirmed first.** An action is a `write` unless you say
  otherwise: the panel shows what will happen (your `confirm` sentence, or the
  action's title with each value given) and runs it only when the user presses
  Confirm. `mode: "read"` is for actions that only change what is shown, such as
  opening a page or a tab; they run at once. A read action must not change data.
  When the same request also previews a layout change, the read action waits
  ("Then: …" under Keep and Discard): Keep runs it, Discard turns it down with
  the preview and says so under the reply. A change waiting to be confirmed, or
  to follow a preview, is cancelled when the user sends another request that
  replaces the preview, or when no preview shows, and the conversation says so.
  A follow-up that only adds to the preview, or a question about it, leaves it
  waiting.
- **Missing details are asked for.** If the user leaves something out ("change
  my last name"), the panel asks for it, and their answer is understood as the
  reply to that question. The panel keeps the last few requests on a screen for
  this.
- **What a change's `run` resolves to is shown to the user.** Return a
  sentence, or nothing for "Done.". Throw an `ActionError` to tell the user why
  it could not be done; any other error shows a general "That couldn't be done"
  so nothing technical reaches them. A read action is quiet when it works, since
  the planner's reply already says what it is showing; set `showResult: true`
  on one whose answer the user needs before deciding, such as the new times a
  change later in the same request will use, and its sentence shows under the
  reply, above the confirmation.
- **The planner is told only how it ended.** Later requests tell the planner,
  the AI model behind the panel, which action ran and whether it was done,
  failed or was cancelled ("Mark an invoice paid — done."), never the sentence
  `run` returned or the `ActionError` message. So "Invoice INV-2041 for Acme Ltd, £12,400" reaches the user's
  screen and goes no further. To let a follow-up build on what an action found
  ("now email that invoice"), set `shareResultWithPlanner: true` on it: the
  sentence and the failure message then also go to the AI model (Anthropic)
  with the user's next few requests.
- **Only the screen's actions are offered.** An action is offered while the
  component that declares it is mounted, so a profile page's actions exist only
  on that page, and one declared near the top of your app exists everywhere.
  `<AdaptiveAction … />` does the same as the hook, from JSX.
- **Screens showing what an action changed must load it again.** ClickLess
  runs your `run` and redraws nothing of your app. An action declared on the
  page it changes can load that page's data again at the end of `run`. One
  declared near the top of your app, and so offered everywhere, changes data
  that another page may be showing; that page keeps the copy it loaded until
  told otherwise. Have it listen for changes the way your app already shares
  them: refresh the cached data when you use a data library (TanStack Query's
  `invalidateQueries`, SWR's `mutate`), or subscribe to your data client's
  own change events.
- **Undo is for changes to the screen.** An action's effect is your
  application's, which ClickLess cannot take back, so once an action has run,
  read or write, the prompt panel and bar do not offer Undo until the screen is
  changed again: it would otherwise take back an older change the user is not
  thinking of. This holds for the rest of the visit to the page; after a
  reload, Undo takes back the latest change to the screen again. To reverse an
  action, the user asks for it ("switch back to light mode").
  `useAdaptiveRegion(id).undoLastChange` always takes back the latest change
  to the screen.
- **Past actions stay listed.** The engine keeps a record of each action run,
  or turned down: the action, its outcome and the names of the fields it was
  given, never their values. The panel lists each past action by its title
  and how it ended ("Change your contact details", Done) after the page is
  loaded again. The request and the reply are not kept.
- **What no action covers is recorded.** "Delete my account", with no action for
  it, is answered with what can be done instead, and recorded as a missed
  request for your team, as layout requests are.

Parameters come in four kinds: `{ type: "text", values?, maxLength? }`,
`{ type: "number", min?, max?, integer? }`, `{ type: "boolean" }` and
`{ type: "file", accept? }`. Each is required unless `required: false`, and its
`description` is what the planner and the confirmation call it. Prefer optional
parameters for changes, so a user can change one thing without restating the
rest.

A **file** parameter takes a file the user attached: the panel shows an attach
button when an action on the screen takes one, and a picture pasted into the
box is attached too. The file stays in the browser and is handed to `run`. Only
its name and type are sent to the engine.

```tsx
useAdaptiveAction({
  name: "updatePhoto",
  title: "Change your profile picture",
  parameters: { photo: { type: "file", description: "Picture", accept: ["image/*"] } },
  run: ({ photo }) => fetch("/api/me/photo", { method: "PUT", body: photo as File }),
});
```

A screen can offer actions with no region on it at all: give the panel an id
for the screen (`<PromptPanel regionId="profile" />`), which is what a missed
request on it is recorded under.

## What the AI model sees

Each request a user makes goes to the engine, which asks an AI model (Anthropic's
Claude) for the change. With it go:

- What the user typed, or what they said once it is turned into text. Where the
  panel covers several regions or offers actions, the last six requests and
  replies in it go too.
- For each region the request is about: its id and `title`, and each section's
  `id`, `kind`, `title`, `description` and `group`, with the settings it may
  have, their allowed values and the sentence each preset gives the model.
- How the region is laid out now: the order, sizes, what is hidden and each
  setting's value.
- The actions on the page: their names, titles and descriptions, and each
  parameter's name, description and allowed values. For one that has run,
  which action it was and whether it was done, failed or cancelled, plus what
  it returned, or the `ActionError` message it failed with, only where
  `shareResultWithPlanner` is set.
- The name and type of a file the user attached, never its contents.

What your sections draw, such as the rows of a table or the numbers on a card,
is never sent: ClickLess sees only what you declare. When dictation is on, the
section titles also go with each recording to OpenAI, as spelling hints.

So everything you declare is sent as you write it, to every user's requests.
Write every string you declare as a label that is the same for everyone, never
built from a user's or a record's data: ids and names as well as titles and
descriptions, and the words you give a preset (`means`, `shows`, `of`,
`entries`, `above.measure`) as well as its values:

```tsx
<Adaptive id="orders" title="Recent orders" … />                       // sent as is
<Adaptive id="orders" title={`${customer.name}'s orders`} … />          // sends the customer's name
<Adaptive id={`orders-${customer.id}`} title="Recent orders" … />       // sends the customer's id
```

The same goes for an action's `title` and `description`, and a parameter's
`description` and `values`: "Open a customer's record", not one built from the
customer on screen.

## Connecting to the engine

`getToken` returns a token your own backend signs for the signed-in user: an
HS256 JWT with the claims `sub` (user id), `tenant` and `exp`, signed with your
tenant's secret, the one the engine holds for that tenant. The secret stays on
your backend. It is called
before every request, so it can refresh an expired token. Signing one in
Node.js takes no library:

```ts
import { createHmac } from "node:crypto";

function signClicklessToken(userId: string, tenantId: string, tenantSecret: string) {
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsignedToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: userId,
    tenant: tenantId,
    exp: Math.floor(Date.now() / 1000) + 300, // five minutes
  })}`;
  const signature = createHmac("sha256", tenantSecret).update(unsignedToken).digest("base64url");
  return `${unsignedToken}.${signature}`;
}
```

Since `getToken` is called before every request, keep the token in memory and
fetch a new one only when it is close to expiring, or your backend is asked for
one each time. Have `getToken` read the session as it is when called, not a
token held from an earlier render:

```ts
let cachedToken: { token: string; expiresAt: number } | undefined;

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const response = await fetch("/api/clickless-token", { credentials: "include" });
  cachedToken = await response.json(); // { token, expiresAt }, from your own backend
  return cachedToken.token;
}
```

A page reload empties the cache, so the first request after one fetches a new
token, signed for the session your own sign-in keeps. Keep the token out of
`localStorage` and cookies: it is short-lived, and the engine reads it only
from the request's `Authorization` header.

`engine` is read once for each signed-in user. Changing its `url` or `getToken`
later has no effect until `userId` changes and the provider mounts afresh, so
pass a `getToken` that stays correct for as long as that user is signed in.
`engine` also takes an optional `fetch`, used in place of the browser's own for
every request to the engine, such as one your tests replace or one that adds
headers your network needs.

The engine's `url` must start with `https://`, so that tokens and requests
cannot be read on the way, or be an address on your own site, such as
`/clickless`, on a page served over HTTPS. Plain `http://` is accepted only for
this machine (`localhost`, `127.0.0.1`, `[::1]` or a `.localhost` name), as in
local development. At any other address nothing is sent, the browser console says
why, and the page behaves as when the engine is unavailable.

The browser calls the engine directly, so the engine must allow your
application's origin, or the browser refuses every answer and the panel only
says personalising isn't available right now. The engine's `CLICKLESS_CORS_ORIGINS`
must list it, such as `["https://app.example.com"]`; when the engine refuses an
origin, its log says which one. The SDK sends its version with every request,
and the engine's log names it when it refuses one, so a build older or newer
than the engine reads is easy to spot.

**Nothing waits for the engine.** A region draws its default layout straight
away. When the user's saved layout arrives, each section glides from where it
was drawn to its saved place and one that was not drawn fades in, so the screen
settles rather than jumps; users who ask for less motion get the change at once.
While the engine is slow, the default layout is what shows. If it is down or
cannot be reached, see "If ClickLess is unavailable" below.

`initialLayout` on a region is shown until the engine's copy has loaded, for
example a layout fetched while rendering on the server. An `initialLayout` that
cannot be read is ignored.

Without `engine`, layouts live in memory: pass `initialLayout` and save what
`onLayoutChange` gives you yourself. Prompts need the engine. Save a layout as
it is given to you, `formatVersion` included: it says which format the layout
is in, and one in a format this version of the SDK does not read is ignored, so
the default shows.

### If ClickLess is unavailable

Your application never depends on the engine to work. If the engine is down,
slow (past the SDK's time limit) or unreachable, its `url` is one it may not be
called at (see "Connecting to the engine"), or `getToken` throws:

- Every region draws straight away, in the layout you wrote (or the
  `initialLayout` you passed), as if the user had never personalised it.
  Nothing is blank, nothing waits, and nothing throws into your page. The SDK
  tries reading the user's saved layout again on its own, a few seconds later
  and then less often, and at once when the browser comes back online or any
  other request gets through, and shows it when it arrives.
- Your own controls keep working. A change through `adaptiveControls.setProp`, or
  through `applyOperations` without a prompt, shows at once, can be undone for
  the rest of the visit, and its promise resolves at once rather than waiting
  or rejecting. It is saved when the engine answers again: the SDK tries again
  on its own, a few seconds later and then less often, and at once when the
  browser comes back online or any other request gets through. A change is
  saved only on top of what it was made on: if the user's saved layout could
  not be read when they made it, or was changed elsewhere meanwhile, and it
  holds something else for the setting the change touched, the change stays on
  screen for the rest of the visit but is not saved, so the next visit shows
  what they had saved. So does a change the engine refuses for good. Such a
  change gives way to the next one that is saved, whether made with your own
  controls, a prompt or a Restore; an Undo of a later change leaves it.
  Changes reach the engine in the order they were made: a prompt's change, or
  a Restore, waits for older ones to be saved first, and while they cannot be
  is refused with a plain message, the one a prompt would get for the same
  cause. A change to a section that has since left the screen, such as one on
  another tab, is saved with the screen it was made on.
- Only prompting needs the engine. `PromptPanel` and `PromptBar` say plainly
  that personalising isn't available right now and, when it applies, that the
  screen may not show the user's saved changes, or that changes made meanwhile
  will be saved when it's back. The panel's button is dimmed
  (`--clickless-unavailable-opacity`) but still opens, to say so and to offer
  Undo. A prompt box of your own gets the same sentence from
  `usePromptBar(id).notice` (put away with `dismissNotice`); for anything else,
  such as dimming your own button, use `usePromptBar(id).available`, and
  `loadFailed` and `hasUnsavedChanges` from `useAdaptiveRegion(id)`.
- A fault in your `onLayoutChange` is reported to the browser and does not
  stop the region.

## Fitting a region to the page's own layout

By default a region is a box of its own: a 12-column grid with rows 80px tall,
in which every section is placed by its `w` and `h`. A section with a height
fills its cell, and when its content is a single element, such as a card, so
does that element. Content that sets its own height in pixels, such as a chart
given `height={350}`, keeps that height whatever the section's size, so give it
`100%` instead for resizing to show.

For fewer columns on narrow screens, give `columns` the columns from each
screen width up, in pixels:

```tsx
<AdaptiveRegion id="dashboard" version="1" columns={{ 0: 1, 768: 12 }}>…</AdaptiveRegion>
```

Users arrange the widest grid, and that is the layout saved and planned. A
narrower screen draws the same arrangement in its own columns, a row at a time,
so each section keeps its share of the width, and a change made on a phone does
not undo what was set for a wide screen. The planner is told how many columns
the user's screen draws, so its replies describe what they see: on a phone,
sections one above the other rather than side by side. It is told too when the
page reads right to left, from its `dir` attribute or a stylesheet's
`direction` (a `lang` attribute alone does not set it), so "left" and
"right" mean what the user sees, and each reply in the panel runs in the
direction of its own words.

`rowHeight="auto"` makes the rows as tall as their content, for something whose
height follows what is in it, such as a table:

```tsx
<AdaptiveRegion id="tasks" version="1" rowHeight="auto">…</AdaptiveRegion>
```

`grid={false}` makes the region draw nothing at all. Each section stays in
whichever of your containers it is written in, so one region can cover a
header, a row of tabs, your own card grids and a menu without any of them
changing. Give the sections that share a container the same `group`:

```tsx
<AdaptiveRegion id="dashboard" version="1" grid={false}>
  <header className="flex gap-2">
    <Adaptive id="search" title="Search" group="header"><Search /></Adaptive>
    <Adaptive id="profile" title="Profile menu" group="header"><ProfileMenu /></Adaptive>
  </header>
  <Adaptive id="download" title="Download" presets={{ look: propPresets.choice({ … }) }}>
    {(props, adaptiveControls, presetValues) => <Button variant={presetValues.look}>Download</Button>}
  </Adaptive>
  <div className="grid grid-cols-12 gap-4">
    <Adaptive id="revenue" title="Total Revenue" group="overview-cards"
      capabilities={{ resize: { minW: 2, maxW: 12, minH: 1, maxH: 3 } }} defaults={{ w: 3, h: 2 }}>
      <RevenueCard />
    </Adaptive>
    <Adaptive id="sales" title="Sales" group="overview-cards" defaults={{ w: 3, h: 2 }}>
      <SalesCard />
    </Adaptive>
  </div>
</AdaptiveRegion>
```

- **Groups.** Sections are put in order only among the others of their `group`:
  "move to the start" means the start of that group, and a request to move a
  card to another tab or into the header is refused, with a reply saying it can
  only be moved among the things next to it. In a region with `grid={false}`, a
  section without a group stays where it is written: it can be hidden or
  changed, but not moved. Groups work the same way in a grid region, to keep
  some of its sections apart from the rest.
- **Sizes.** `w` and `h` are optional with `grid={false}`. A section without
  them, such as a button or a menu, is sized by the page and is never offered
  for resizing. One with them is given `grid-column` and `grid-row` spans, which
  a grid of your own, such as the card grid above, then uses; `columns` says how
  many columns that grid has, and so how wide a section can be made. In a
  region's own grid both are needed.
- **Order.** Moves are drawn with CSS `order`, counted within the group, so a
  component's state survives a move. A section is given an `order` only while
  its group is shown in an order other than the one written, so a group that
  has never been moved leaves your own elements beside it alone. Once a group
  has been moved, your own elements in the same container come before its
  sections; give a movable group a container to itself, or put your own
  elements first in it.
- **Keyboard and screen readers.** So that the Tab key and screen readers
  follow what is shown, a region sets `reading-flow: grid-order`, which
  browsers that support it use for both, and once a user has moved a section it
  lists its sections in the shown order with `aria-owns`, which screen readers
  use. In a browser without `reading-flow`, screen readers still read them in
  the shown order, but the Tab key follows the order written in the source. A
  moved group's container does the same, when it holds nothing but that group.
- **Finding a section.** Each section's element has an `id` that starts with
  `clickless-` and is unique on the page; to find one from your own code or
  styles, use its `data-clickless-item` attribute instead. With `grid={false}`,
  `className` and `style` on the region are not used, since there is no element
  to put them on.

## A screen made of several regions

A sidebar, a header or a row of tabs that every page shares has to be a region
of its own: inside each page's region its layout would be saved once per page.
Leave the regions as they are and give the prompt panel all of their ids:

```tsx
<AdaptiveRegion id="sidebar" version="1" title="Sidebar">…</AdaptiveRegion>
<AdaptiveRegion id="dashboard" version="1">…</AdaptiveRegion>

<PromptPanel regionId={["dashboard", "sidebar"]} />
```

`PromptBar`, `usePromptBar` and `useChangeHistory` take a list in the same way,
and a single id means what it always did. With a list:

- One prompt, such as "hide Chats in the sidebar and move Sales first", is
  planned for all the regions in one request, so the model sees everything on
  the screen.
- The preview shows in every region it changes, and Keep and Discard act on all
  of it. Each region's part is saved to that region, so the sidebar's layout is
  still the same one on every page.
- Keep saves every part or none. If one region was changed somewhere else in
  the meantime, nothing is saved, that region is refreshed, and the user is
  asked to try again.
- Undo takes back the last change in one go, in every region it reached, even
  one on a page that is not open, and the reply names it: the request in the
  user's words, or what the change did. A region that has had a later change
  since keeps its part, and the reply says that part stays in place elsewhere. The list of past changes is one conversation for all the regions, and
  "Restore to this point" returns all of them to how they were then.
- When part of a request cannot be done, the rest is still previewed and the
  reply says which part was left out.
- A region in the list that is not on the screen is left out until it is, so
  the same list can be used on pages that lack one of them.

Several regions in one panel need the engine, and an engine recent enough to
have its `/v1/changes` endpoints. Put the page first in the list, which may
name up to 8 regions. Give each
region a `title`, what users call that part of the screen: it is how the model
knows which one "in the sidebar" means, and what its replies call it.

## The prompt panel

`PromptPanel` is a floating button that opens a panel for asking for changes.
Users see a preview of each change before anything is saved, and choose Keep or
Discard. The panel lists their past changes, a few at a time, each with the
request, the reply, a way to reuse the request, and "Restore to this point".
It can be minimised to show the whole page; while a preview is waiting, the
button that reopens it reads "Keep or discard?". When a preview appears, the
page scrolls to what changed. `PromptBar` is the same thing as an inline bar.

The button and the panel's title both read "Ask ClickLess" unless you name them
yourself, in words that fit your application:

```tsx
<PromptPanel regionId="dashboard" label="Customise" title="Customise this screen" />
```

What a preview changes is outlined with a dashed line in the panel's accent
colour, so users see what Keep will save before they choose; a section the
preview hides is simply gone, and the reply says so. The same outline marks each
section drawn differently from the user's version while "See original" is
showing. Restyle it with `--clickless-preview-outline`, a whole outline such as
`2px dashed #0f766e` (`none` turns it off), and
`--clickless-preview-outline-offset` (`4px` by default). A section's own `style`
changes it for that section. Each outlined section also carries
`data-clickless-preview="changed"` for anything else a stylesheet should do to
it; the outline itself is set by the variables, which take precedence over a
stylesheet's `outline`. A section that draws nothing of its own, such as one
that only hands settings to a component drawn elsewhere, has nothing to outline:
give that component a rule of its own on the attribute, such as
`body:has([data-clickless-item="menu"][data-clickless-preview="changed"]) nav`.

A section that holds several things, such as a row of counts above a table, is
better outlined where the change is than all round. Its render function's
controls say what changed: `isChanged(name)` and `changeOutline(name)` take a
prop's name, or the name of a preset in `presets` for all of its props, and,
for a list such as the columns, an entry, which counts as changed when it is new
or had to move. `changeOutline` gives the same outline as a style, or nothing
where the part is drawn the same; put it on that part. Set `marksChanges` on the
section, and its own outline is kept for hiding, moving or resizing it:

```tsx
<Adaptive id="txns" title="Transactions" marksChanges presets={{ columns, rows: propPresets.density() }}>
  {(props, adaptiveControls, presetValues) => (
    <table style={adaptiveControls.changeOutline("rows")}>
      <tr>
        {presetValues.columns.map((column) => (
          <th key={column} style={adaptiveControls.changeOutline("columns", column)}>{column}</th>
        ))}
      </tr>
    </table>
  )}
</Adaptive>
```

While "See original" shows, a column the user removed is there again, and
outlined.

A request leaves the box once it is sent; the conversation still shows the one
sent. A request that could not be carried out, as when the engine cannot be
reached, is put back in the box to send again, unless something else was typed
meanwhile.

A request typed while a preview is showing builds on it: "make Revenue wider",
then "wider again", widens it from the preview, and "not that one, the other
card" takes back that part of it. Its change is added to the preview, Keep
saves the whole as one change, listed in the history with its requests
together, and Discard goes back to the saved layout. A reply with nothing to
change, such as an answer to a question, leaves the preview as it is, and with
it anything the request that made the preview asked to do once it is decided
on. If the screen was changed somewhere else meanwhile, the preview is taken
off, the user is told, and the request is put back in the box to send again.

Leaving a page does not lose what the user typed. A request typed and not sent
is kept for the regions the panel speaks for, and is back in the box when the
user returns to them, for as long as the `AdaptiveProvider` stays mounted and
the same user is signed in. A
panel for `"dashboard"` and one for `["dashboard", "sidebar"]` keep their own.
When Keep is refused because the screen was changed somewhere else, such as in
another browser tab, the request is put back in the box, ready to send again.
While a preview waits for Keep or Discard, or is being saved, closing or
reloading the browser tab makes the browser ask first; at any other time it
does not. A change being saved when the tab closes anyway is still sent, and
saved, as long as it is no larger than browsers carry on sending (about 60 KB).
A reload straight after may show the page before that save has landed; the
change is there on the next read. Going to another page inside your
application is not held up: the preview is taken off and recorded as abandoned.

Once the screen differs from how it first looked, two buttons stay pinned under
the panel's title. "See original" shows the screen as it first looked, in place
and without saving anything, so users can spot a section they removed; each
section drawn differently from their version is marked as in a preview. From
there they choose "Back to my version" or "Keep the original". "Revert to original" puts
the original back at once, and can be undone. A request, Undo or any other
change ends the look at the original, as does leaving the page the panel is on.
Closing or minimising the panel does not: its button then reads "Seeing
original", and opening it offers the way back.

The button sits in the bottom-right corner unless you say otherwise:
`position` takes `"bottom-right"`, `"bottom-left"`, `"top-right"` or
`"top-left"`, and the panel opens from the same corner. To move the button in
from the edges, for example clear of a tab bar or a chat bubble, set
`--clickless-launcher-offset-x` and `--clickless-launcher-offset-y` (16px each
by default), each with its unit (`0px`, not `0`). The button and panel sit in
front of the page at a z-index of 1000; to put them in front of, or behind,
something of your own, such as a modal, set `--clickless-panel-z-index`.

Both components are themed with CSS custom properties, so they need no
stylesheet and no class names from you:

```css
:root {
  --clickless-accent: #0f766e;        /* buttons and links */
  --clickless-accent-text: #ffffff;   /* the writing on those buttons */
  --clickless-user-bubble: #0f766e;   /* the user's requests */
  --clickless-user-text: #ffffff;
  --clickless-reply-bubble: #f0fdfa;  /* the replies */
  --clickless-reply-border: #0f766e;
  --clickless-bubble-radius: 6px;
}
```

Also available: `--clickless-surface`, `--clickless-text`, `--clickless-muted`,
`--clickless-border`, `--clickless-danger` and `--clickless-reply-text`. A page
that sets none of them gets a panel that follows it: it turns dark when the
page's background is dark, however the page switches theme, and back again. A
page that sets any of them on its root or body has chosen its own colours, so
the rest stay light rather than mix with them; such a page looks best mapping
the variables to its own colours, as shadcn's `--card`, `--foreground`,
`--primary` and the like, which then follow its light and dark themes with it.
A page that paints no background of its own on `<html>` or `<body>` is followed
by its theme attribute or class there, its `color-scheme`, or the background
in the middle of the screen. To choose instead, as for an app that keeps its
theme in its own state, pass `colorScheme="light"`, `"dark"` or `"auto"` (the
default) to `PromptPanel` or `PromptBar`, or once to `AdaptiveProvider`.
Bubbles carry `data-clickless-bubble="user"` or `"reply"` for anything the
variables do not cover. A request shows as soon as it is sent: in
`PromptPanel` as the user's bubble with a `"working"` one under it until the
answer comes, the panel scrolling so the newest of these stays in view, and in
`PromptBar` as one `"working"` line holding the sign and the request. While the screen shows how it first looked, the bar saying so
carries `data-clickless-original="showing"`.

## Speaking a request

`<PromptPanel dictation />` shows a microphone button, when the engine is set
up for it and the browser can record. The user speaks, presses Done, and what
they said is added to the box for them to read, change and send; nothing is sent for them.
If it seems to hold a password, card number or other private detail, nothing is
added to the box and the user is told why.
While they speak, bars move with their voice, and a recording in which nothing
was said is never sent. A recording ends by itself after a minute.
Nothing is recorded until the user presses the button.

It is off unless you turn it on, because what users say leaves your
application: the recording goes to the engine, which passes it to OpenAI's
speech-to-text service to be turned into text. Turn it on where your
agreements with your users and customers cover that.

Three things on your side decide whether it works:

- The page is served over HTTPS (or from `localhost`). Browsers give no
  microphone to a page that is not.
- If you send a `Permissions-Policy` header, it allows the microphone for your
  own origin: `microphone=(self)`.
- If the application runs inside an `<iframe>`, the frame has `allow="microphone"`.

The engine keeps neither the recording nor its text; what OpenAI keeps is set by
its terms with whoever runs the engine. The titles of the sections on the
screen are sent with the recording as hints, so that their names are spelt as
you spell them.

The button carries `data-clickless-dictation="start"` for a stylesheet to
target. `dictationLabels` replaces any of its wording (`speak`, `starting`,
`listening`, `transcribing`, `done`, `cancel`), and `renderDictationButton`
draws a button of your own in its place, still only with `dictation`:

```tsx
<PromptPanel
  regionId="dashboard"
  dictation
  dictationLabels={{ speak: "Dictate", done: "Finished" }}
  renderDictationButton={({ start, disabled, label }) => (
    <button type="button" aria-label={label} disabled={disabled} onClick={start}>
      <MyMicIcon />
    </button>
  )}
/>
```

The bars read `--clickless-recording` for their colour. What replaces the
button while the user speaks carries `data-clickless-dictation` too, as
`"starting"`, `"recording"` or `"transcribing"`. While it is `"recording"`,
`--clickless-dictation-level` is set on it several times a second: a number
from 0 (silence) to 1 (loud).

## Building your own controls

For controls you build yourself, such as a column picker, the render function
also receives `adaptiveControls.setProp(propName, propValue)`. It goes through the same checks,
storage and undo as a request made in words, but takes effect at once, without
waiting for the engine, and its promise resolves at once and never rejects
because the engine is unavailable (see "If ClickLess is unavailable").
Resolving means the change is shown, not that it is saved; `hasUnsavedChanges`
from `useAdaptiveRegion(id)` says whether any change is still waiting to be saved.
It resolves to `{ applied: true, layout }`, or to `{ applied: false, errors }`
when the manifest does not allow the change, such as a value the prop does not
offer, and then nothing changes on screen.

```tsx
{(props, adaptiveControls, presetValues) => (
  <ColumnPicker
    visible={presetValues.columns}
    onChange={(shownColumns) => adaptiveControls.setProp("columns", shownColumns)}
  />
)}
```

To build your own panel or bar, the hooks behind the built-in ones are
exported:

- `usePromptBar(id)`: the request, the preview, Keep, Discard, Undo and restore.
  `requestInProgress` holds a sent request until its answer comes, and is null
  otherwise, so a custom panel can show it at once.
  `differsFromOriginal` says when there is an original to offer,
  `showOriginal(true)` shows the screen as it first looked, `showingOriginal`
  says it is showing, and `showOriginal(false)` goes back to the user's version.
  Call `showOriginal(false)` when your panel leaves the page, or the screen
  stays on the original. `prompt` and `setPrompt` keep an unsent request per
  set of regions, and the browser asks before the tab closes while `previewing`,
  as in the built-in panel.
- `useChangeHistory(id)`: a user's past changes, a page at a time.
- `useDictation({ onTranscript })`: the microphone, whose recordings go to
  OpenAI as described in [Speaking a request](#speaking-a-request). It returns `available`,
  `status`, `elapsedSeconds`, `error`, `clearError`, `start`, `stop`, `cancel`
  and a `soundLevelRef` for the element that should carry the sound level.
  When what was said seems to hold a private detail, `onTranscript` is not
  called and `error` says why.
- `useAdaptiveAction(definition)`: offers an action, as described above.
- `useAdaptiveRegion(id)`: one region's manifest and layout, with
  `applyOperations`, `previewOperations`, `commitPreview`, `cancelPreview`,
  `discardPreview`, `undoLastChange` and `planFromPrompt`. `undoLastChange`
  resolves to `{ keptElsewhere, undoneChange }`: `keptElsewhere` is true when
  part of the change stays in a region that changed again since, and
  `undoneChange` is the change taken back (its `prompt`, `kind` and
  `operations`), or null when the engine does not say. `describeHistoryEntry`
  turns it into words.

Call `discardPreview` when the user turns a preview down, and `cancelPreview`
when your application takes one off the screen for a reason of its own: only
the first is recorded as a missed request. `planFromPrompt` plans from the
preview showing, if there is one, and adds its answer to it: the `operations`
it resolves to are what the request changes from the screen shown. One that
takes the whole preview back records it as discarded. With no preview showing,
any preview that appears while it waits is taken off when its answer comes,
and recorded as discarded if it came from a request. A preview from a request that
the screen takes off before the user chose, because a region it changed
unmounted or its components changed, as on going to another page, is recorded
as abandoned instead. Closing a prompt bar leaves its preview waiting.

## When your screens change

Each user's layout is saved against what a region contained at the time. When a
release of your application adds, removes or changes sections, a saved layout
is fitted to the region as it is now rather than thrown away:

- A new section is placed after its nearest neighbour.
- A setting is reset to its default only where your new declaration no longer
  allows the saved value.
- A section that is not on screen, such as one in a closed tab, keeps what the
  user set on it, and gets it back when it is shown again. Nothing has to be
  declared for this, and tabs do not have to keep their content mounted.

What a user set on a section is saved under its `id`, so keep ids the same
through redesigns and refactors. Restyling a section or rewriting the component
inside it keeps everything the user set. A section whose `id` changes is a new
section to ClickLess: it starts from its defaults, and what the user set under
the old id is not carried over.

Bump a region's `version` when a release adds, removes or renames sections, not
when they come and go on screen. The panel tells a returning user, in plain
words, what was added or reset since they arranged the screen. Without the bump
new sections are not mentioned: a section the saved layout has not met is taken
to have been off screen when it was saved, and it quietly shows its defaults.
Settings reset because your declaration no longer allows them are mentioned
either way.
