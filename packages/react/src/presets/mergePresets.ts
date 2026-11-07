import type { Capabilities, LayoutItem } from "@clickless/core";
import type { PropPreset } from "./propPresets";

type OwnDeclaration = {
  description: string | undefined;
  capabilities: Partial<Omit<Capabilities, "props">> | undefined;
  defaults: Partial<Pick<LayoutItem, "w" | "h" | "hidden">>;
};

type Declaration = {
  description: string | undefined;
  capabilities: Partial<Capabilities> | undefined;
  defaults: Partial<Pick<LayoutItem, "w" | "h" | "hidden" | "props">>;
};

// Defined rather than assigned, so that an entry named "__proto__" stays an entry,
// which <Adaptive> then refuses, instead of replacing the object's prototype.
function setOwnEntry<Value>(target: Record<string, Value>, name: string, value: Value) {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A component's declaration with its presets folded in: their props make up
 * `capabilities.props`, their starting values `defaults.props`, and their
 * sentences follow `description` in order. A prop declared by two presets is
 * refused, since its two meanings would contradict.
 */
export function mergePresets(
  componentId: string,
  declaration: OwnDeclaration,
  presets: readonly PropPreset[],
): Declaration {
  if (presets.length === 0) return declaration;
  const presetProps: NonNullable<Capabilities["props"]> = {};
  const presetDefaults: LayoutItem["props"] = {};
  for (const preset of presets) {
    for (const [propName, propCapabilities] of Object.entries(preset.capabilities)) {
      if (Object.hasOwn(presetProps, propName)) {
        throw new Error(
          `<Adaptive id="${componentId}">: the ${preset.preset} preset declares "${propName}", which another preset ` +
            "already declares. Remove one of them, or file the custom one under another name.",
        );
      }
      setOwnEntry(presetProps, propName, propCapabilities);
    }
    for (const [propName, defaultValue] of Object.entries(preset.defaults)) {
      setOwnEntry(presetDefaults, propName, defaultValue);
    }
  }
  const ownDescription = declaration.description?.trim();
  const descriptionParts = [
    ownDescription && !/[.!?]$/.test(ownDescription) ? `${ownDescription}.` : ownDescription,
    ...presets.map((preset) => preset.description),
  ].filter(Boolean);
  return {
    description: descriptionParts.join(" "),
    capabilities: { ...declaration.capabilities, props: presetProps },
    defaults: { ...declaration.defaults, props: presetDefaults },
  };
}
