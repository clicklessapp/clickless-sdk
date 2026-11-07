import { ownPropertyValue } from "./ownProperties";
import { propAcceptsValue } from "./propValues";
import type { Component, Manifest, Operation, PropCapabilities } from "./schemas.gen";

export type OperationErrorCode =
  | "unknown_component"
  | "locked"
  | "capability_not_allowed"
  | "invalid_target"
  | "invalid_operation"
  | "out_of_bounds"
  | "unknown_prop"
  | "invalid_value"
  | "empty_region";

export interface OperationError {
  /** Position of the offending operation in the list. */
  index: number;
  code: OperationErrorCode;
  message: string;
}

type OperationFailure = [OperationErrorCode, string];

/**
 * Checks every operation against the manifest and reports at most one error per
 * operation. The check order is part of the contract shared with the Python
 * engine: component exists, not locked, capability declared, then the
 * operation's own arguments.
 */
export function validateOperations(manifest: Manifest, operations: readonly Operation[]): OperationError[] {
  const componentsById = new Map(manifest.components.map((component) => [component.id, component]));
  const operationErrors: OperationError[] = [];
  operations.forEach((operation, operationIndex) => {
    const operationFailure = findOperationFailure(manifest, componentsById, operation);
    if (operationFailure) operationErrors.push({ index: operationIndex, code: operationFailure[0], message: operationFailure[1] });
  });
  return operationErrors;
}

function findOperationFailure(
  manifest: Manifest,
  componentsById: Map<string, Component>,
  operation: Operation,
): OperationFailure | undefined {
  if (operation.type === "reorder") {
    for (const componentId of operation.ids) {
      const operationFailure =
        checkComponentCanBeChanged(componentsById, componentId) ??
        checkComponentMovable(componentsById.get(componentId)!);
      if (operationFailure) return operationFailure;
    }
    if (new Set(operation.ids).size !== operation.ids.length) {
      return ["invalid_operation", "reorder lists the same component more than once"];
    }
    const firstComponent = componentsById.get(operation.ids[0]!)!;
    const componentInAnotherGroup = operation.ids
      .map((componentId) => componentsById.get(componentId)!)
      .find((component) => component.group !== firstComponent.group);
    if (componentInAnotherGroup) {
      return [
        "invalid_operation",
        `"${firstComponent.id}" and "${componentInAnotherGroup.id}" are in different groups; components can only be put in order among those in their own group`,
      ];
    }
    return undefined;
  }

  if (operation.type === "reset") {
    return operation.id === undefined ? undefined : checkComponentCanBeChanged(componentsById, operation.id);
  }

  const operationFailure = checkComponentCanBeChanged(componentsById, operation.id);
  if (operationFailure) return operationFailure;
  const component = componentsById.get(operation.id)!;

  switch (operation.type) {
    case "move": {
      const movableFailure = checkComponentMovable(component);
      if (movableFailure) return movableFailure;
      if (operation.position === "start" || operation.position === "end") return undefined;
      if (operation.targetId === undefined) {
        return ["invalid_target", `move ${operation.position} needs a targetId`];
      }
      if (operation.targetId === operation.id) {
        return ["invalid_target", `"${operation.id}" cannot be moved relative to itself`];
      }
      const targetComponent = componentsById.get(operation.targetId);
      if (!targetComponent) {
        return ["unknown_component", `no component "${operation.targetId}" in this region`];
      }
      if (targetComponent.group !== component.group) {
        return [
          "invalid_target",
          `"${operation.id}" can only be moved among the components in its own group, and "${operation.targetId}" is in another`,
        ];
      }
      return undefined;
    }
    case "hide":
    case "show":
      return component.capabilities.hide
        ? undefined
        : ["capability_not_allowed", `"${operation.id}" cannot be hidden or shown`];
    case "resize": {
      const resizeLimits = component.capabilities.resize;
      // A component without a size is placed by the page, so there is nothing to resize.
      if (!resizeLimits || component.defaults.w === undefined) {
        return ["capability_not_allowed", `"${operation.id}" cannot be resized`];
      }
      if (operation.w === undefined && operation.h === undefined) {
        return ["invalid_operation", "resize needs a width or a height"];
      }
      const maxWidth = Math.min(resizeLimits.maxW, manifest.columns);
      if (operation.w !== undefined && (operation.w < resizeLimits.minW || operation.w > maxWidth)) {
        return [
          "out_of_bounds",
          `width of "${operation.id}" must be between ${resizeLimits.minW} and ${maxWidth}`,
        ];
      }
      if (operation.h !== undefined && (operation.h < resizeLimits.minH || operation.h > resizeLimits.maxH)) {
        return [
          "out_of_bounds",
          `height of "${operation.id}" must be between ${resizeLimits.minH} and ${resizeLimits.maxH}`,
        ];
      }
      return undefined;
    }
    case "setProp": {
      const propCapabilities = ownPropertyValue(component.capabilities.props, operation.prop);
      if (!propCapabilities) {
        return ["unknown_prop", `"${operation.id}" has no adjustable prop "${operation.prop}"`];
      }
      if (!propAcceptsValue(propCapabilities, operation.value)) {
        return [
          "invalid_value",
          `"${operation.prop}" of "${operation.id}" must be ${describeAcceptedValues(propCapabilities)}`,
        ];
      }
      return undefined;
    }
  }
}

function describeAcceptedValues(propCapabilities: PropCapabilities): string {
  if ("type" in propCapabilities) {
    if (propCapabilities.type === "color") return "a colour written as #rrggbb";
    return `a ${propCapabilities.integer ? "whole " : ""}number from ${propCapabilities.min} to ${propCapabilities.max}`;
  }
  const allowedValuesText = JSON.stringify(propCapabilities.values);
  if (!propCapabilities.multiple) return `one of ${allowedValuesText}`;
  const listText = `a list of at least ${propCapabilities.min ?? 0} different entries from ${allowedValuesText}`;
  return propCapabilities.required?.length
    ? `${listText}, always including ${JSON.stringify(propCapabilities.required)}`
    : listText;
}

function checkComponentCanBeChanged(
  componentsById: Map<string, Component>,
  componentId: string,
): OperationFailure | undefined {
  const component = componentsById.get(componentId);
  if (!component) return ["unknown_component", `no component "${componentId}" in this region`];
  if (component.locked) return ["locked", `"${componentId}" is locked and cannot be changed`];
  return undefined;
}

function checkComponentMovable(component: Component): OperationFailure | undefined {
  return component.capabilities.move
    ? undefined
    : ["capability_not_allowed", `"${component.id}" cannot be moved`];
}
