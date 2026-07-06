import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useRef, type ReactNode, type RefObject } from "react";

const MAIN_SCROLLPORT_SELECTOR = ".main-scrollport";

function getMainScrollport(from: HTMLElement | null): Element | null {
  if (!from) return null;
  return from.closest(MAIN_SCROLLPORT_SELECTOR);
}

type VirtualListProps<T> = {
  items: T[];
  estimateSize: number;
  renderItem: (item: T, index: number) => ReactNode;
  getItemKey?: (item: T, index: number) => string | number;
  overscan?: number;
  className?: string;
  /** Override the scroll container (e.g. queue panel's own scrollport). */
  scrollElement?: RefObject<Element | null>;
};

export function VirtualList<T>({
  items,
  estimateSize,
  renderItem,
  getItemKey,
  overscan = 10,
  className,
  scrollElement,
}: VirtualListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement?.current ?? getMainScrollport(listRef.current),
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: getItemKey
      ? (index) => getItemKey(items[index]!, index)
      : undefined,
  });

  return (
    <div ref={listRef} className={className}>
      <VirtualListBody virtualizer={virtualizer} items={items} renderItem={renderItem} />
    </div>
  );
}

function VirtualListBody<T>({
  virtualizer,
  items,
  renderItem,
}: {
  virtualizer: Virtualizer<Element, Element>;
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
}) {
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      style={{
        height: virtualizer.getTotalSize(),
        width: "100%",
        position: "relative",
      }}
    >
      {virtualItems.map((virtualRow) => (
        <div
          key={virtualRow.key}
          data-index={virtualRow.index}
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${virtualRow.start}px)`,
            contentVisibility: "auto",
            containIntrinsicSize: `auto ${virtualRow.size}px`,
          }}
        >
          {renderItem(items[virtualRow.index]!, virtualRow.index)}
        </div>
      ))}
    </div>
  );
}