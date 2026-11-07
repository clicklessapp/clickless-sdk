import { useRef, type CSSProperties } from "react";
import { usePromptBar } from "../hooks/usePromptBar";
import { builtInColorVariables, usePanelColorScheme, type ColorSchemeSetting } from "./hostColorScheme";
import { useRegionStoreRegistry } from "../region/regionContext";
import { ClicklessUiErrorBoundary } from "./ClicklessUiErrorBoundary";
import { WORKING_WORDING, WorkingDots } from "./WorkingDots";
import { regionIdsKeyOf } from "../hooks/useRegionGroup";
import { useFocusAfterPromptAction } from "./focusAfterPromptAction";
import { buttonStyle, controlStyle, dangerColor, mutedColor, primaryButtonStyle } from "./promptPanelStyles";

export interface PromptBarProps {
  /**
   * The region the bar changes. Give several ids when the screen is made of
   * more than one region, such as a page and a shared sidebar: one prompt is
   * then planned, previewed, kept and undone across all of them.
   * A list may name up to 8 regions.
   */
  regionId: string | readonly string[];
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * The colours it is drawn in: "light", "dark", or "auto" to follow the page.
   * Default: AdaptiveProvider's `colorScheme`, which is "auto" unless set.
   */
  colorScheme?: ColorSchemeSetting;
}

// Themed with CSS custom properties so it needs no stylesheet:
// --clickless-accent, --clickless-accent-text, --clickless-border, --clickless-surface,
// --clickless-text, --clickless-danger.

/** A ready-made prompt bar. For a custom one, use `usePromptBar`. */
export function PromptBar(props: PromptBarProps) {
  // Outside the boundary, so a bar placed outside AdaptiveProvider still says so.
  useRegionStoreRegistry();
  return (
    <ClicklessUiErrorBoundary resetKey={regionIdsKeyOf(props.regionId)}>
      <PromptBarContents {...props} />
    </ClicklessUiErrorBoundary>
  );
}

function PromptBarContents({
  regionId,
  placeholder = "Describe how you want this screen to look",
  className,
  style,
  colorScheme: colorSchemeSetting,
}: PromptBarProps) {
  const promptBar = usePromptBar(regionId);
  const isBusy = promptBar.status !== "idle";
  const colorScheme = usePanelColorScheme(colorSchemeSetting);
  const promptInput = useRef<HTMLInputElement>(null);
  // Keep, Discard, Undo and OK can leave the page once used, and the focus
  // that was on them is kept instead of being lost.
  const thenKeepFocus = useFocusAfterPromptAction(promptInput, !isBusy);

  return (
    <div
      data-clickless-prompt-bar={typeof regionId === "string" ? regionId : regionId.join(" ")}
      className={className}
      style={{ ...builtInColorVariables(colorScheme), display: "grid", gap: 8, ...style }}
    >
      <form
        style={{ display: "flex", gap: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          promptBar.submitPrompt();
        }}
      >
        <input
          ref={promptInput}
          dir="auto"
          aria-label="Describe a change to this screen"
          placeholder={placeholder}
          value={promptBar.prompt}
          onChange={(event) => promptBar.setPrompt(event.target.value)}
          maxLength={2000}
          // Read-only, not disabled, while busy: a disabled box drops the keyboard focus.
          readOnly={isBusy}
          aria-busy={isBusy}
          style={{ ...controlStyle, flex: 1, minWidth: 0 }}
        />
        <button type="submit" disabled={isBusy || promptBar.prompt.trim() === ""} style={primaryButtonStyle}>
          {promptBar.status === "planning" ? "Working…" : promptBar.offersActions ? "Send" : "Preview"}
        </button>
        {promptBar.canUndo && !promptBar.previewing && (
          <button type="button" disabled={isBusy} onClick={thenKeepFocus(promptBar.undoLastChange)} style={buttonStyle}>
            Undo
          </button>
        )}
      </form>

      {promptBar.notice && (
        <div role="status" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span dir="auto" style={{ flex: 1 }}>{promptBar.notice}</span>
          <button type="button" onClick={thenKeepFocus(promptBar.dismissNotice)} style={buttonStyle}>
            OK
          </button>
        </div>
      )}

      {/* The box empties when a request is sent, so the request and a sign of work show until its answer comes. */}
      {promptBar.requestInProgress !== null && (
        <div data-clickless-bubble="working" role="status" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <WorkingDots />
          <span dir="auto" style={{ flex: 1, minWidth: 0 }}>
            {WORKING_WORDING} <span style={{ color: mutedColor }}>“{promptBar.requestInProgress}”</span>
          </span>
        </div>
      )}

      {(promptBar.latestReply || promptBar.previewing || promptBar.pendingActionCalls) && (
        <div
          role={promptBar.latestReply?.isError ? "alert" : "status"}
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          {promptBar.latestReply && (
            <span
              // In the direction of its own words, whichever way the page reads.
              dir="auto"
              style={{
                flex: 1,
                minWidth: 200,
                ...(promptBar.latestReply.isError && { color: dangerColor }),
              }}
            >
              {promptBar.latestReply.text}
            </span>
          )}
          {promptBar.pendingActionCalls && (
            <>
              <span dir="auto" style={{ flexBasis: "100%", fontWeight: 600 }}>
                {promptBar.pendingActionCalls.map((pendingCall) => pendingCall.summary).join(" ")}
              </span>
              <button type="button" disabled={isBusy} onClick={thenKeepFocus(promptBar.confirmActionCalls)} style={primaryButtonStyle}>
                {promptBar.status === "saving" ? "Working…" : "Confirm"}
              </button>
              <button type="button" disabled={isBusy} onClick={thenKeepFocus(promptBar.cancelActionCalls)} style={buttonStyle}>
                Cancel
              </button>
            </>
          )}
          {promptBar.previewing && (
            <>
              {promptBar.callsAfterPreview && (
                <span dir="auto" data-clickless-after-preview style={{ flexBasis: "100%", color: mutedColor }}>
                  Then: {promptBar.callsAfterPreview.map((waitingCall) => waitingCall.summary).join(" ")}
                </span>
              )}
              <button type="button" disabled={isBusy} onClick={thenKeepFocus(promptBar.keepPreview)} style={primaryButtonStyle}>
                {promptBar.status === "saving" ? "Saving…" : "Keep"}
              </button>
              <button type="button" disabled={isBusy} onClick={thenKeepFocus(promptBar.discardPreview)} style={buttonStyle}>
                Discard
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
