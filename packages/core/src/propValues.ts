import type { PropCapabilities, PropValue } from "./schemas.gen";

export function clonePropValue(propValue: PropValue): PropValue {
  return Array.isArray(propValue) ? [...propValue] : propValue;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Whether a prop declared this way may hold the value. Comparison is strict on
 * purpose: "25" is not 25 and 1 is not true.
 */
export function propAcceptsValue(propCapabilities: PropCapabilities, propValue: PropValue): boolean {
  if ("type" in propCapabilities) {
    if (propCapabilities.type === "color") {
      return typeof propValue === "string" && HEX_COLOR_PATTERN.test(propValue);
    }
    // An infinite range would otherwise let through a value JSON cannot hold.
    return (
      typeof propValue === "number" &&
      Number.isFinite(propValue) &&
      propValue >= propCapabilities.min &&
      propValue <= propCapabilities.max &&
      (!propCapabilities.integer || Number.isInteger(propValue))
    );
  }
  if (!propCapabilities.multiple) {
    return !Array.isArray(propValue) && propCapabilities.values.includes(propValue);
  }
  return (
    Array.isArray(propValue) &&
    propValue.length >= (propCapabilities.min ?? 0) &&
    new Set(propValue).size === propValue.length &&
    propValue.every((listEntry) => propCapabilities.values.includes(listEntry)) &&
    (propCapabilities.required ?? []).every((requiredEntry) => propValue.includes(requiredEntry))
  );
}

export function propValuesEqual(firstValue: PropValue | undefined, secondValue: PropValue | undefined): boolean {
  if (Array.isArray(firstValue) && Array.isArray(secondValue)) {
    return (
      firstValue.length === secondValue.length &&
      firstValue.every((listEntry, entryIndex) => listEntry === secondValue[entryIndex])
    );
  }
  return firstValue === secondValue;
}
