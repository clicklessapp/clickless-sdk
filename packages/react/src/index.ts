export { AdaptiveProvider, type AdaptiveProviderProps } from "./components/AdaptiveProvider";
export { AdaptiveRegion, type AdaptiveRegionProps } from "./components/AdaptiveRegion";
export type { RegionColumns } from "./region/responsiveColumns";
export { Adaptive, type AdaptiveControls, type AdaptiveProps } from "./components/Adaptive";
export {
  propPresets,
  type ColourReading,
  type CustomPreset,
  type PresetSet,
  type PresetValues,
  type PropPreset,
} from "./presets/propPresets";
export { PromptBar, type PromptBarProps } from "./components/PromptBar";
export type { ColorSchemeSetting } from "./components/hostColorScheme";
export {
  PromptPanel,
  type DictationButtonProps,
  type DictationLabels,
  type PromptPanelPosition,
  type PromptPanelProps,
} from "./components/PromptPanel";
export { AdaptiveAction, type AdaptiveActionProps } from "./components/AdaptiveAction";
export { useAdaptiveAction } from "./hooks/useAdaptiveAction";
export {
  ActionError,
  type ActionArgumentValue,
  type ActionArguments,
  type ActionDefinition,
} from "./actions/actionRegistry";
export { useAdaptiveRegion } from "./hooks/useAdaptiveRegion";
export { usePromptBar, type PromptBarMessage, type PromptBarStatus, type PromptTurn } from "./hooks/usePromptBar";
export {
  describeHistoryEntry,
  useChangeHistory,
  type ChangeHistoryOptions,
} from "./hooks/useChangeHistory";
export { useDictation, type DictationOptions, type DictationStatus } from "./hooks/useDictation";
export { EngineError, type EngineOptions } from "./engine/engineClient";
export type { HistoryEntry, UndoneChange } from "./engine/engineResponses";
export type { RegionSnapshot } from "./region/regionSnapshot";
export type { LayoutChangeHandler, UndoResult } from "./region/regionStore";
export { contrastRatio, ensureReadableTextColor, readableTextColor } from "@clickless/core";
// The format's types, so an application needs no second package to type a saved
// layout, an operation or a component's capabilities.
export type {
  Action,
  ActionCall,
  ActionParameter,
  ApplyOperationsOutcome,
  Capabilities,
  Component,
  Layout,
  LayoutChange,
  LayoutItem,
  Manifest,
  Operation,
  OperationError,
  PropCapabilities,
  PropValue,
} from "@clickless/core";
