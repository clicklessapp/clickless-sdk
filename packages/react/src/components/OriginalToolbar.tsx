import type { CSSProperties } from "react";
import { borderStyle, buttonStyle, primaryButtonStyle } from "./promptPanelStyles";

function EyeIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function RevertIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

// Smaller than the panel's other buttons, so the bar stays one short row.
const toolbarSizing: CSSProperties = { padding: "4px 10px", fontSize: "0.85em" };
const toolbarButtonStyle: CSSProperties = {
  ...buttonStyle,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  ...toolbarSizing,
};
const primaryToolbarButtonStyle: CSSProperties = { ...primaryButtonStyle, ...toolbarSizing };

export interface OriginalToolbarProps {
  showingOriginal: boolean;
  differsFromOriginal: boolean;
  /** True when the original can be put back, which needs a history kept by the engine. */
  canRevert: boolean;
  isBusy: boolean;
  previewing: boolean;
  showOriginal: (shown: boolean) => void;
  revertToOriginal: () => void;
  /** Wraps each button's click handler, so the focus is not lost when the button goes. */
  thenKeepFocus: (buttonAction: () => void) => (event: { currentTarget: HTMLElement }) => void;
}

/**
 * The bar pinned under the panel's title, so going back to the start never
 * means scrolling to the top of a long history. It offers a look at how the
 * screen first looked and a way to put that back; during the look, it says so
 * and offers the way out of it.
 */
export function OriginalToolbar({
  showingOriginal,
  differsFromOriginal,
  canRevert,
  isBusy,
  previewing,
  showOriginal,
  revertToOriginal,
  thenKeepFocus,
}: OriginalToolbarProps) {
  if (showingOriginal) {
    return (
      <div
        data-clickless-original="showing"
        style={{ display: "grid", gap: 8, padding: "10px 14px", borderBottom: borderStyle }}
      >
        <p role="status" style={{ margin: 0 }}>
          {canRevert
            ? "You're seeing the original. Nothing is saved unless you keep it."
            : "You're seeing the original. Nothing has been saved."}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" onClick={thenKeepFocus(() => showOriginal(false))} style={toolbarButtonStyle}>
            Back to my version
          </button>
          {canRevert && (
            <button type="button" disabled={isBusy} onClick={thenKeepFocus(revertToOriginal)} style={primaryToolbarButtonStyle}>
              Keep the original
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!differsFromOriginal) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "8px 14px", borderBottom: borderStyle }}>
      <button
        type="button"
        disabled={isBusy || previewing}
        title="Shows how this screen first looked, without changing anything"
        onClick={thenKeepFocus(() => showOriginal(true))}
        style={toolbarButtonStyle}
      >
        <EyeIcon />
        See original
      </button>
      {canRevert && (
        <button
          type="button"
          disabled={isBusy}
          title="Puts this screen back the way it first looked. You can undo this."
          onClick={thenKeepFocus(revertToOriginal)}
          style={toolbarButtonStyle}
        >
          <RevertIcon />
          Revert to original
        </button>
      )}
    </div>
  );
}
