import type { CSSProperties } from "react";

// Styles shared by the prompt panel and the prompt bar. Each lists the custom
// properties a host can set at its top: PromptPanel.tsx and PromptBar.tsx.
export const borderStyle = "1px solid var(--clickless-border, var(--clickless-built-in-border, #d6d3cb))";
export const surfaceColor = "var(--clickless-surface, var(--clickless-built-in-surface, #fff))";
const accentColor = "var(--clickless-accent, var(--clickless-built-in-accent, #1c5cab))";
export const mutedColor = "var(--clickless-muted, var(--clickless-built-in-muted, #52514e))";
export const dangerColor = "var(--clickless-danger, var(--clickless-built-in-danger, #a82a2a))";
// The bars that move while the user speaks.
export const recordingColor = "var(--clickless-recording, var(--clickless-danger, var(--clickless-built-in-danger, #a82a2a)))";

// What every control shares, a text box as much as a button.
export const controlStyle: CSSProperties = {
  font: "inherit",
  padding: "8px 12px",
  borderRadius: 8,
  border: borderStyle,
  background: surfaceColor,
  color: "var(--clickless-text, var(--clickless-built-in-text, #0b0b0b))",
};
export const buttonStyle: CSSProperties = {
  ...controlStyle,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
export const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: accentColor,
  borderColor: accentColor,
  color: "var(--clickless-accent-text, var(--clickless-built-in-accent-text, #fff))",
};
export const linkButtonStyle: CSSProperties = {
  font: "inherit",
  fontSize: "0.85em",
  padding: 0,
  border: 0,
  background: "none",
  color: accentColor,
  cursor: "pointer",
  textDecoration: "underline",
};

const bubbleRadius = "var(--clickless-bubble-radius, 14px)";
const bubbleStyle: CSSProperties = {
  margin: 0,
  padding: "8px 12px",
  maxWidth: "85%",
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
};
export const userBubbleStyle: CSSProperties = {
  ...bubbleStyle,
  justifySelf: "end",
  background: `var(--clickless-user-bubble, ${accentColor})`,
  color: "var(--clickless-user-text, var(--clickless-accent-text, var(--clickless-built-in-accent-text, #fff)))",
  borderRadius: `${bubbleRadius} ${bubbleRadius} 4px ${bubbleRadius}`,
};
export const replyBubbleStyle: CSSProperties = {
  ...bubbleStyle,
  justifySelf: "start",
  background: `var(--clickless-reply-bubble, ${surfaceColor})`,
  color: "var(--clickless-reply-text, var(--clickless-text, var(--clickless-built-in-text, #0b0b0b)))",
  border: "1px solid var(--clickless-reply-border, var(--clickless-border, var(--clickless-built-in-border, #d6d3cb)))",
  borderRadius: `${bubbleRadius} ${bubbleRadius} ${bubbleRadius} 4px`,
};
export const historyEntryDetailsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "2px 12px",
  alignItems: "baseline",
  color: mutedColor,
  fontSize: "0.85em",
};

export const attachmentChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  maxWidth: "100%",
  padding: "2px 8px",
  borderRadius: 999,
  border: borderStyle,
  fontSize: "0.85em",
};
