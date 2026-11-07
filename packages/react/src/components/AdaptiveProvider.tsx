import { useEffect, useState, type ReactNode } from "react";
import { RegionStoreRegistryContext, RegionStoreRegistry } from "../region/regionContext";
import type { EngineOptions } from "../engine/engineClient";
import { ColorSchemeSettingContext, type ColorSchemeSetting } from "./hostColorScheme";

export interface AdaptiveProviderProps {
  /**
   * Who is signed in: the user id your backend puts in the token's `sub`.
   * When it changes, everything inside the provider is mounted afresh, so
   * nothing the last user typed or changed is shown to the next one. A token
   * `getToken` gives for anyone else is never sent, so nothing the last user
   * left unsaved is saved to the next one's account, even when signing out
   * shows a page without ClickLess. A provider is for one tenant too: where
   * someone can switch tenant without a reload, give the provider the tenant
   * as its `key`.
   */
  userId: string;
  /**
   * Connects regions to the ClickLess engine, which stores each user's layout
   * and plans changes from prompts. Read once for each signed-in user. Without it,
   * layouts live in memory and `onLayoutChange` is the only way to persist them.
   */
  engine?: EngineOptions;
  /**
   * Regions whose saved layouts are read from the engine as soon as the
   * provider mounts, before they are on the screen, such as a sidebar that a
   * phone only draws once its menu is opened. Each then shows its saved layout
   * the moment it mounts, rather than its default for as long as the read
   * takes. A region not listed is read when it first mounts. Read once for
   * each signed-in user, like `engine`.
   */
  preloadRegions?: readonly string[];
  /**
   * The colours of every PromptPanel and PromptBar inside that sets none of
   * its own: "light", "dark", or "auto" (the default) to follow the page.
   */
  colorScheme?: ColorSchemeSetting;
  children: ReactNode;
}

export function AdaptiveProvider({
  userId,
  colorScheme = "auto",
  ...signedInUserProviderProps
}: AdaptiveProviderProps) {
  return (
    <ColorSchemeSettingContext.Provider value={colorScheme}>
      <SignedInUserProvider key={userId} userId={userId} {...signedInUserProviderProps} />
    </ColorSchemeSettingContext.Provider>
  );
}

/** What one signed-in user's visit holds, from the moment they sign in until another does. */
function SignedInUserProvider({ userId, engine, preloadRegions, children }: AdaptiveProviderProps) {
  const [storeRegistry] = useState(() => new RegionStoreRegistry(engine, userId));
  const [regionsToPreload] = useState(() => preloadRegions ?? []);
  useEffect(() => {
    storeRegistry.resume();
    for (const regionId of regionsToPreload) storeRegistry.storeFor(regionId).preloadSavedLayout();
    return storeRegistry.dispose;
  }, [storeRegistry, regionsToPreload]);
  return <RegionStoreRegistryContext.Provider value={storeRegistry}>{children}</RegionStoreRegistryContext.Provider>;
}
