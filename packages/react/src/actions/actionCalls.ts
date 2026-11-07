import { validateActionCalls, type Action, type ActionCall } from "@clickless/core";
import { ActionError, type ActionArguments, type ActionDefinition, type RegisteredAction } from "./actionRegistry";

/** An action call checked against what the page offers, ready to confirm or run. */
export interface PreparedActionCall {
  registeredAction: RegisteredAction;
  actionArguments: ActionArguments;
  /** What the user is asked to confirm, or told is happening. */
  summary: string;
  mode: "read" | "write";
  /**
   * The action's `run` as it was when the summary was written. What runs is
   * what the user was shown, even if the component offering it has since
   * re-rendered for something else, such as another customer's record.
   */
  run: ActionDefinition["run"];
  /** Whether the planner is told what `run` said, as the action opted in when it was offered. */
  shareResultWithPlanner: boolean;
  /** Whether a read's result is shown to the user, as the action opted in when it was offered. */
  showResult: boolean;
}

/** Said when the planner asked for an action the page no longer offers as it was. */
export const ACTION_NO_LONGER_AVAILABLE_MESSAGE = "That can't be done on this screen right now.";
/** Said when the screen changed while a change waited to be confirmed, so it was not made. */
export const SCREEN_CHANGED_BEFORE_CONFIRM_MESSAGE = "This screen changed, so that wasn't done. Please ask again.";
const ACTION_FAILED_MESSAGE = "That couldn't be done. Please try again.";

/**
 * Checks the planner's calls against the actions on the page now, which may
 * have changed while it worked, and fills each file parameter with the file
 * itself. Null when any call no longer fits, or is for an action the page now
 * declares differently from what the planner was shown, such as a change it
 * now offers as something that runs at once.
 */
export function prepareActionCalls(
  registeredActions: readonly RegisteredAction[],
  actionCalls: readonly ActionCall[],
  attachedFiles: readonly File[],
  declarationsSent: readonly Action[],
): PreparedActionCall[] | null {
  const declarations = registeredActions.map((registeredAction) => registeredAction.declaration);
  if (validateActionCalls(declarations, actionCalls, attachedFiles).length > 0) return null;
  const declarationChanged = actionCalls.some((actionCall) => {
    const sentDeclaration = declarationsSent.find((declaration) => declaration.name === actionCall.name);
    const currentDeclaration = declarations.find((declaration) => declaration.name === actionCall.name);
    return JSON.stringify(sentDeclaration) !== JSON.stringify(currentDeclaration);
  });
  if (declarationChanged) return null;
  return actionCalls.map((actionCall) => {
    const registeredAction = registeredActions.find((candidate) => candidate.declaration.name === actionCall.name)!;
    const { parameters } = registeredAction.declaration;
    const actionArguments: ActionArguments = Object.fromEntries(
      Object.entries(actionCall.arguments).map(([parameterName, argumentValue]) => [
        parameterName,
        parameters[parameterName]!.type === "file" ? attachedFiles[argumentValue as number]! : argumentValue,
      ]),
    );
    const definition = registeredAction.definition();
    return {
      registeredAction,
      actionArguments,
      summary: summariseActionCall(registeredAction, actionArguments),
      mode: registeredAction.declaration.mode,
      run: definition.run,
      shareResultWithPlanner: definition.shareResultWithPlanner ?? false,
      showResult: definition.showResult ?? false,
    };
  });
}

function summariseActionCall(registeredAction: RegisteredAction, actionArguments: ActionArguments): string {
  const { confirm } = registeredAction.definition();
  if (confirm) {
    try {
      return confirm(actionArguments);
    } catch {
      // A sentence that could not be written is no reason not to ask.
    }
  }
  const { title, parameters } = registeredAction.declaration;
  const givenValues = Object.entries(actionArguments).map(([parameterName, argumentValue]) => {
    const label = parameters[parameterName]?.description ?? wordsOfName(parameterName);
    return `${label}: ${describeArgument(argumentValue)}`;
  });
  return givenValues.length > 0 ? `${title}. ${givenValues.join(", ")}.` : `${title}.`;
}

/** A parameter's name as words, for a parameter given no description: `phoneNumber` is "phone number". */
export function wordsOfName(parameterName: string): string {
  const words = parameterName
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function describeArgument(argumentValue: ActionArguments[string]): string {
  if (typeof argumentValue === "boolean") return argumentValue ? "yes" : "no";
  if (typeof argumentValue === "object") return argumentValue.name;
  return String(argumentValue);
}

/**
 * Runs one call. Resolves to whether it worked, what to tell the user, and
 * what to tell the planner: the action's title and how it ended, or what the
 * user was told when the action shares it.
 */
export async function runActionCall(
  preparedCall: PreparedActionCall,
): Promise<{ done: boolean; text: string; noteForPlanner: string; returnedText: boolean }> {
  const runResult = await runAndDescribe(preparedCall);
  const noteForPlanner = preparedCall.shareResultWithPlanner
    ? runResult.text
    : plannerNoteOf(preparedCall, runResult.done ? "done" : "failed");
  return { ...runResult, noteForPlanner };
}

async function runAndDescribe(
  preparedCall: PreparedActionCall,
): Promise<{ done: boolean; text: string; returnedText: boolean }> {
  try {
    const runOutcome = await preparedCall.run(preparedCall.actionArguments);
    const returnedText = typeof runOutcome === "string" && runOutcome.trim() !== "";
    return { done: true, text: returnedText ? (runOutcome as string) : "Done.", returnedText };
  } catch (error) {
    return { done: false, text: error instanceof ActionError ? error.message : ACTION_FAILED_MESSAGE, returnedText: false };
  }
}

/**
 * What the planner is told of calls that never ran, and why, such as
 * "cancelled": their titles only, never what the user was shown of them.
 */
export function describeNotRunForPlanner(preparedCalls: readonly PreparedActionCall[], reason: string): string {
  return preparedCalls.map((preparedCall) => plannerNoteOf(preparedCall, reason)).join(" ");
}

/** One call as the planner is told of it: the action's title, then how it ended. */
function plannerNoteOf(preparedCall: PreparedActionCall, howItEnded: string): string {
  return `${preparedCall.registeredAction.declaration.title} — ${howItEnded}.`;
}
