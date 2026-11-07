/**
 * A request whose answer is part of the preview on the screen. A follow-up
 * typed during a preview adds its change to the preview, so one preview can
 * hold several, and is kept or discarded as one change.
 */
export interface PreviewRequest {
  prompt: string;
  /** What the planner answered: what this request changed from the screen it was typed on. */
  message: string;
  viaVoice: boolean;
}

// The longest prompt and message the engine stores with a change.
const MAX_PROMPT_LENGTH = 2000;
const MAX_MESSAGE_LENGTH = 2000;

const lengthInCharacters = (text: string): number => [...text].length;

/**
 * How the change the requests made together is told, as it is saved or
 * reported: their prompts one to a line, and their answers one after another.
 * The oldest requests are left out where all of them would be too long to store.
 */
export function describePreviewRequests(previewRequests: readonly PreviewRequest[]): {
  prompt: string;
  message: string;
  viaVoice: boolean;
} {
  let keptRequests = previewRequests;
  const joinedPrompts = () => keptRequests.map((previewRequest) => previewRequest.prompt).join("\n");
  const joinedMessages = () => keptRequests.map((previewRequest) => previewRequest.message).join(" ");
  while (
    keptRequests.length > 1 &&
    (lengthInCharacters(joinedPrompts()) > MAX_PROMPT_LENGTH ||
      lengthInCharacters(joinedMessages()) > MAX_MESSAGE_LENGTH)
  ) {
    keptRequests = keptRequests.slice(1);
  }
  return {
    prompt: joinedPrompts(),
    message: joinedMessages(),
    // Counted as spoken when any part of it was, for the usage metrics.
    viaVoice: previewRequests.some((previewRequest) => previewRequest.viaVoice),
  };
}
