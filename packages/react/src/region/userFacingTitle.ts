import type { Component } from "@clickless/core";

/**
 * The component's title, for text the user reads, or null when it has none of
 * its own. A component given no title carries its id as its title, for the
 * planner, and an id such as "txns" means nothing to the user.
 */
export function userFacingTitleOf(component: Pick<Component, "id" | "title">): string | null {
  const title = typeof component.title === "string" ? component.title.trim() : "";
  return title === "" || title === component.id ? null : title;
}
