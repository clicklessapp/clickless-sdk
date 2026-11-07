import type { Action, ActionCall, ActionParameter } from "./schemas.gen";

export type ActionCallErrorCode = "unknown_action" | "unknown_argument" | "missing_argument" | "invalid_argument";

export interface ActionCallError {
  /** Position of the offending call in the list. */
  index: number;
  code: ActionCallErrorCode;
  message: string;
}

/** What a call is told about a file the user attached: only its media type, never its content. */
export interface AttachedFile {
  type: string;
}

const ACTION_OR_PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type ActionCallFailure = [ActionCallErrorCode, string];

/**
 * Checks every call against the actions declared, and reports at most one error
 * per call. The check order is part of the contract shared with the Python
 * engine: the action exists, then each argument is one it declares (in the
 * order the call gives them), then each required parameter is given and each
 * value is one it accepts (in the order the action declares them).
 */
export function validateActionCalls(
  actions: readonly Action[],
  actionCalls: readonly ActionCall[],
  attachedFiles: readonly AttachedFile[] = [],
): ActionCallError[] {
  const actionsByName = new Map(actions.map((action) => [action.name, action]));
  const actionCallErrors: ActionCallError[] = [];
  actionCalls.forEach((actionCall, callIndex) => {
    const callFailure = findActionCallFailure(actionsByName, actionCall, attachedFiles);
    if (callFailure) actionCallErrors.push({ index: callIndex, code: callFailure[0], message: callFailure[1] });
  });
  return actionCallErrors;
}

function findActionCallFailure(
  actionsByName: ReadonlyMap<string, Action>,
  actionCall: ActionCall,
  attachedFiles: readonly AttachedFile[],
): ActionCallFailure | undefined {
  const action = actionsByName.get(actionCall.name);
  if (!action) return ["unknown_action", `there is no action "${actionCall.name}"`];
  for (const argumentName of Object.keys(actionCall.arguments)) {
    if (!Object.hasOwn(action.parameters, argumentName)) {
      return ["unknown_argument", `"${action.name}" has no parameter "${argumentName}"`];
    }
  }
  for (const [parameterName, parameter] of Object.entries(action.parameters)) {
    if (!Object.hasOwn(actionCall.arguments, parameterName)) {
      if (parameter.required ?? true) return ["missing_argument", `"${action.name}" needs "${parameterName}"`];
      continue;
    }
    if (!parameterAcceptsArgument(parameter, actionCall.arguments[parameterName]!, attachedFiles)) {
      return [
        "invalid_argument",
        `"${parameterName}" of "${action.name}" must be ${describeAcceptedArguments(parameter)}`,
      ];
    }
  }
  return undefined;
}

function parameterAcceptsArgument(
  parameter: ActionParameter,
  argumentValue: string | number | boolean,
  attachedFiles: readonly AttachedFile[],
): boolean {
  switch (parameter.type) {
    case "text":
      return (
        typeof argumentValue === "string" &&
        argumentValue.trim() !== "" &&
        // Counted in characters, as Python counts them, not in UTF-16 code units.
        (parameter.maxLength === undefined || [...argumentValue].length <= parameter.maxLength) &&
        (parameter.values === undefined || parameter.values.includes(argumentValue))
      );
    case "number":
      return (
        typeof argumentValue === "number" &&
        Number.isFinite(argumentValue) &&
        (parameter.min === undefined || argumentValue >= parameter.min) &&
        (parameter.max === undefined || argumentValue <= parameter.max) &&
        (!parameter.integer || Number.isInteger(argumentValue))
      );
    case "boolean":
      return typeof argumentValue === "boolean";
    case "file": {
      if (typeof argumentValue !== "number" || !Number.isInteger(argumentValue)) return false;
      const attachedFile = attachedFiles[argumentValue];
      return attachedFile !== undefined && fileTypeAccepted(parameter.accept, attachedFile.type);
    }
  }
}

/** Whether a media type is one of `accept`, where `image/*` stands for every image type. */
export function fileTypeAccepted(acceptedTypes: readonly string[] | undefined, fileType: string): boolean {
  if (acceptedTypes === undefined) return true;
  const mediaType = fileType.toLowerCase();
  return acceptedTypes.some((acceptedType) => {
    const accepted = acceptedType.toLowerCase();
    return accepted.endsWith("/*") ? mediaType.startsWith(accepted.slice(0, -1)) : mediaType === accepted;
  });
}

function describeAcceptedArguments(parameter: ActionParameter): string {
  switch (parameter.type) {
    case "text":
      if (parameter.values !== undefined) return `one of ${JSON.stringify(parameter.values)}`;
      return parameter.maxLength === undefined ? "some text" : `some text of at most ${parameter.maxLength} characters`;
    case "number": {
      const numberKind = parameter.integer ? "a whole number" : "a number";
      if (parameter.min !== undefined && parameter.max !== undefined) {
        return `${numberKind} from ${parameter.min} to ${parameter.max}`;
      }
      if (parameter.min !== undefined) return `${numberKind} of at least ${parameter.min}`;
      if (parameter.max !== undefined) return `${numberKind} of at most ${parameter.max}`;
      return numberKind;
    }
    case "boolean":
      return "true or false";
    case "file":
      return parameter.accept === undefined
        ? "an attached file"
        : `an attached file of type ${parameter.accept.join(" or ")}`;
  }
}

/**
 * Why a list of actions cannot be offered, or undefined if it can: two with one
 * name, a parameter with a name a call could not use, or a number range that
 * holds nothing. Worded as the engine words it.
 */
export function findActionsFailure(actions: readonly Action[]): string | undefined {
  const seenNames = new Set<string>();
  for (const action of actions) {
    if (seenNames.has(action.name)) return `two actions are named "${action.name}"`;
    seenNames.add(action.name);
    for (const [parameterName, parameter] of Object.entries(action.parameters)) {
      if (!ACTION_OR_PARAMETER_NAME.test(parameterName)) {
        return `"${action.name}" has a parameter named "${parameterName}": a parameter name is a letter, then up to 63 letters, digits or _`;
      }
      if (
        parameter.type === "number" &&
        parameter.min !== undefined &&
        parameter.max !== undefined &&
        parameter.min > parameter.max
      ) {
        return `"${parameterName}" of "${action.name}" has a min above its max`;
      }
    }
  }
  return undefined;
}
