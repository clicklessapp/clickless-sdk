import type { Action, ActionParameter } from "@clickless/core";

/** What a file parameter is given when the action runs: the file itself. */
export type ActionArgumentValue = string | number | boolean | File;

export type ActionArguments = Record<string, ActionArgumentValue>;

/** What an application gives to offer one action. */
export interface ActionDefinition {
  /** How the planner names it: a letter, then letters, digits or _. Unique on the page. */
  name: string;
  /** What users would call it, such as "Change your name". Shown when asking them to confirm. */
  title: string;
  /** When to use it, for the planner. */
  description?: string;
  /**
   * `write` (the default) changes something, so the user confirms before it runs.
   * `read` only changes what is shown, such as opening a page or a tab, and runs
   * at once. A read action must not change data.
   */
  mode?: "read" | "write";
  /** What it needs, by name. Text, numbers, true or false, or a file the user attached. */
  parameters?: Record<string, ActionParameter>;
  /**
   * The sentence the user confirms, such as "Change your name to Joshua King?".
   * Without it, the title is shown with each value given.
   */
  confirm?: (actionArguments: ActionArguments) => string;
  /**
   * Carries the action out, with the user's own sign-in, as your own screens
   * would. For a `write` action, what it resolves to, if text, is shown to the
   * user; otherwise "Done.". A `read` action's result is shown only with
   * `showResult`, since the planner's reply already says what it is showing.
   * Throw an `ActionError` to show the user why it could not be done, whatever
   * the mode.
   */
  run: (actionArguments: ActionArguments) => unknown;
  /**
   * True to tell the planner what `run` resolves to, or the `ActionError`
   * message, so a later request can build on it ("now email that invoice").
   * That text then goes to the AI model (Anthropic) with the user's next few
   * requests. Off by default: the planner is told only the action's title and
   * whether it was done, failed or was cancelled, while the user still sees
   * the full sentence.
   */
  shareResultWithPlanner?: boolean;
  /**
   * For a `read` action: true to show the user the sentence `run` resolves to,
   * under the planner's reply. A read that resolves to no sentence stays quiet. For a read whose answer the user needs before they
   * decide, such as the new times a later change in the same request would
   * use. Off by default, so actions that open or filter a page stay quiet.
   */
  showResult?: boolean;
}

/** An action as it is offered on the page now. */
export interface RegisteredAction {
  declaration: Action;
  /** The definition as last rendered, so `run` and `confirm` may be inline functions. */
  definition: () => ActionDefinition;
}

/** Thrown from an action's `run` to tell the user, in a sentence, why it could not be done. */
export class ActionError extends Error {
  constructor(userMessage: string) {
    super(userMessage);
    this.name = "ActionError";
  }
}

export function declarationOf(definition: ActionDefinition): Action {
  return {
    name: definition.name,
    title: definition.title,
    ...(definition.description !== undefined && { description: definition.description }),
    mode: definition.mode ?? "write",
    parameters: definition.parameters ?? {},
  };
}

/**
 * The actions offered on the page right now. Each registers while the component
 * that offers it is mounted, so the planner sees only what the screen can do.
 */
export class ActionRegistry {
  private registered: RegisteredAction[] = [];
  private cachedActions: readonly RegisteredAction[] = [];
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Stable until the actions on offer change. */
  getActions = (): readonly RegisteredAction[] => this.cachedActions;

  /** Offers an action until the returned function is called. */
  register(registeredAction: RegisteredAction): () => void {
    this.registered = [...this.registered, registeredAction];
    this.changed();
    return () => {
      this.registered = this.registered.filter((candidate) => candidate !== registeredAction);
      this.changed();
    };
  }

  private changed(): void {
    // Two offering one name: the one mounted last is used, as it is what the screen shows now.
    const byName = new Map<string, RegisteredAction>();
    for (const registeredAction of this.registered) byName.set(registeredAction.declaration.name, registeredAction);
    this.cachedActions = [...byName.values()];
    for (const listener of [...this.listeners]) listener();
  }
}

const NO_ACTIONS: readonly RegisteredAction[] = [];
export const getServerActions = (): readonly RegisteredAction[] => NO_ACTIONS;
