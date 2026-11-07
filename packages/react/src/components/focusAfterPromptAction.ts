import { useEffect, useRef, type RefObject } from "react";

/**
 * Keeps the keyboard focus somewhere once a button of the panel or bar has
 * done its work. Keep, Discard, Undo, OK and Restore can leave the page when
 * used, which would drop the focus on the page's body: it goes back to the
 * button if that is still there, else to the prompt box. A user who has moved
 * on to something else meanwhile keeps their place, and a press or focus
 * anywhere else forgets the button, so a later render never moves the focus.
 *
 * `actionsSettled` is true while nothing a button began is still under way.
 * Returns a wrapper for a button's click handler.
 */
export function useFocusAfterPromptAction(
  promptInput: RefObject<HTMLElement | null>,
  actionsSettled: boolean,
): (buttonAction: () => void) => (event: { currentTarget: HTMLElement }) => void {
  const pressedButton = useRef<HTMLElement | null>(null);
  // The pressed button only counts for what its own click brought about. Once
  // the user presses or moves the focus anywhere else, a later render, perhaps
  // after a click that changed nothing, must not pull the focus back to it.
  useEffect(() => {
    const forgetPressedButton = (event: Event) => {
      const pressedButtonElement = pressedButton.current;
      if (pressedButtonElement && !(event.target instanceof Node && pressedButtonElement.contains(event.target))) {
        pressedButton.current = null;
      }
    };
    document.addEventListener("pointerdown", forgetPressedButton, true);
    document.addEventListener("focusin", forgetPressedButton, true);
    return () => {
      document.removeEventListener("pointerdown", forgetPressedButton, true);
      document.removeEventListener("focusin", forgetPressedButton, true);
    };
  }, []);
  // After every render, since the button may leave in any of them.
  useEffect(() => {
    const pressedButtonElement = pressedButton.current;
    if (!actionsSettled || !pressedButtonElement) return;
    pressedButton.current = null;
    const focusedElement = document.activeElement;
    const focusWasLeftBehind = !focusedElement || focusedElement === document.body || focusedElement === pressedButtonElement;
    if (!focusWasLeftBehind) return;
    if (pressedButtonElement.isConnected && !(pressedButtonElement as HTMLButtonElement).disabled) pressedButtonElement.focus();
    else promptInput.current?.focus();
  });
  return (buttonAction) => (event) => {
    pressedButton.current = event.currentTarget;
    buttonAction();
  };
}
