// Room between two saved items for the components added since, in drawing order.
const FIRST_PAINT_ORDER_SPACING = 1000;

/**
 * Where each item is drawn before the region has mounted: on the server and
 * on the first paint. There is no manifest yet, only the saved layout and the
 * items as they render, one after another in the order they are written.
 *
 * A saved item keeps its saved place. One added since the layout was saved
 * goes straight after the item written before it, or first if it is written
 * first, which is where reconciling puts it once the region mounts.
 *
 * "Written before" is taken to be "rendered before". That holds unless part
 * of the region is inside a Suspense boundary that is still waiting while the
 * server sends the rest: items after it then render first, and an added item
 * may be drawn out of place until the region mounts.
 */
export class FirstPaintOrder {
  private placedItems: { itemId: string; drawOrder: number }[] = [];

  /** `savedIndex` is the item's position in the saved order, or -1 if it is not in it. */
  placeItem(itemId: string, savedIndex: number): number {
    // An item may render more than once; it keeps the neighbour it had the first time.
    let placedIndex = this.placedItems.findIndex((placedItem) => placedItem.itemId === itemId);
    if (placedIndex < 0) placedIndex = this.placedItems.push({ itemId, drawOrder: 0 }) - 1;
    const previousDrawOrder =
      placedIndex > 0 ? this.placedItems[placedIndex - 1]!.drawOrder : -FIRST_PAINT_ORDER_SPACING;
    const drawOrder =
      savedIndex >= 0 ? savedIndex * FIRST_PAINT_ORDER_SPACING : previousDrawOrder + 1;
    this.placedItems[placedIndex]!.drawOrder = drawOrder;
    return drawOrder;
  }
}
