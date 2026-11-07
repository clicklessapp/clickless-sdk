import type { Manifest, ResizeCapabilities } from "./schemas.gen";

/**
 * Why a manifest that passes its schema still cannot be used, or undefined
 * when it can: a component with half a default size, one that can be resized
 * but has no default size, one resized between limits that contradict each
 * other or its default size, or one with a list that must hold an entry it
 * does not offer. The engine refuses the same manifests with the
 * same messages (its `validate_manifest`), on top of the request limits it
 * alone enforces.
 */
export function findManifestFailure(manifest: Manifest): string | undefined {
  for (const component of manifest.components) {
    const hasWidth = component.defaults.w !== undefined;
    const hasHeight = component.defaults.h !== undefined;
    if (hasWidth !== hasHeight) return `Component "${component.id}" has a default width or height but not both`;
    for (const [propName, propCapabilities] of Object.entries(component.capabilities.props ?? {})) {
      const offersEveryRequiredEntry =
        !("values" in propCapabilities) ||
        (propCapabilities.required ?? []).every((requiredEntry) => propCapabilities.values.includes(requiredEntry));
      if (!offersEveryRequiredEntry) {
        return `Component "${component.id}" requires an entry its prop "${propName}" does not offer`;
      }
    }
    const resizeLimits = component.capabilities.resize;
    if (!resizeLimits) continue;
    if (!hasWidth) return `Component "${component.id}" can be resized but has no default size`;
    const resizeLimitsFailure = findResizeLimitsFailure(
      component.id,
      resizeLimits,
      component.defaults.w!,
      component.defaults.h!,
    );
    if (resizeLimitsFailure) return resizeLimitsFailure;
  }
  return undefined;
}

/** Limits no size could meet, or a default size the limits leave out. */
function findResizeLimitsFailure(
  componentId: string,
  resizeLimits: ResizeCapabilities,
  defaultWidth: number,
  defaultHeight: number,
): string | undefined {
  if (resizeLimits.minW > resizeLimits.maxW) {
    return `Component "${componentId}" has a smallest width (minW) larger than its largest (maxW)`;
  }
  if (resizeLimits.minH > resizeLimits.maxH) {
    return `Component "${componentId}" has a smallest height (minH) larger than its largest (maxH)`;
  }
  if (defaultWidth < resizeLimits.minW || defaultWidth > resizeLimits.maxW) {
    return `Component "${componentId}" has a default width outside the widths it can be resized to`;
  }
  if (defaultHeight < resizeLimits.minH || defaultHeight > resizeLimits.maxH) {
    return `Component "${componentId}" has a default height outside the heights it can be resized to`;
  }
  return undefined;
}
