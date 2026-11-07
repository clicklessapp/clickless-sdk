import { EngineError, isEngineUnavailable } from "./engineClient";

/** Said to the user when a change they previewed can no longer be made. */
export const PREVIEW_NO_LONGER_FITS_MESSAGE = "That change no longer fits this screen. Please try again.";

/** Said when a change would leave a part of the screen with nothing on it. */
export const WOULD_EMPTY_PAGE_MESSAGE = "That would leave this page empty, so nothing was changed.";

/** Said when the engine cannot be reached, or cannot answer, so nothing can be personalised for now. */
export const ENGINE_UNAVAILABLE_MESSAGE = "Personalising isn't available right now. Please try again in a little while.";

/** Said when a recording held no speech that could be made out. */
export const NOTHING_HEARD_MESSAGE = "We couldn't hear anything. Please try again.";

/**
 * A sentence for the person using the application. The engine's own error text
 * is written for developers, so none of it is passed through.
 */
export function describeError(error: unknown): string {
  if (error instanceof EngineError) {
    if (error.status === 401) return "You have been signed out. Please sign in again.";
    // Signed in, but this account may not change this screen.
    if (error.status === 403) return "You don't have permission to change this screen.";
    switch (error.code) {
      case "conflict":
        return "This screen was changed somewhere else. It has been refreshed, so please try again.";
      case "nothing_to_undo":
        return "There is nothing to undo.";
      case "invalid_operations":
        // Trying again would fail the same way, so the user is not asked to.
        return error.errors?.some((operationError) => operationError.code === "empty_region")
          ? WOULD_EMPTY_PAGE_MESSAGE
          : PREVIEW_NO_LONGER_FITS_MESSAGE;
      case "manifest_too_large":
      case "invalid_manifest":
      case "duplicate_region":
      case "unstorable_value":
        // Trying again would send the same screen and fail the same way.
        return "This screen can't be changed right now.";
      case "service_busy":
        return "Lots of people are asking right now. Please try again in a moment.";
      case "request_too_large":
        return "That was too much to send in one go. Please try something shorter.";
      case "too_many_requests":
        // Said for typed and for spoken requests alike.
        return "You've asked for a lot in a short time. Please wait a minute and try again.";
      case "unknown_revision":
        return "That earlier version is no longer available.";
      case "planner_not_configured":
      case "planner_unavailable":
        return "Changes can't be made by typing right now. Please try again in a little while.";
      case "dictation_not_configured":
      case "transcriber_unavailable":
      case "unsupported_recording":
        return "Speaking isn't available right now. You can still type what you want.";
      case "recording_too_large":
        return "That was too long to take in. Please say it in fewer words, or type it.";
      case "empty_recording":
        return NOTHING_HEARD_MESSAGE;
    }
    // The user can do nothing different about any of these causes, so they are told one thing.
    if (isEngineUnavailable(error)) return ENGINE_UNAVAILABLE_MESSAGE;
  }
  return "Something went wrong. Please try again.";
}
