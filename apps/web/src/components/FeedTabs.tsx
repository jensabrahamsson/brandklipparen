// Start-page list tabs (DX-1 §A3.1): below 1280 px the two lists share
// one column behind two tabs ("New pairs · on-chain" and "DexScreener ·
// market"), each with its pictogram slot and count. Real tab pattern:
// roving tabindex with ArrowRight/ArrowLeft/Home/End switching, the
// choice remembered in sessionStorage by the parent. Static motion: no
// animation of its own.
import { useRef, type JSX, type KeyboardEvent } from "react";

export type FeedTabId = "live" | "market";

export const FEED_TAB_STORAGE_KEY = "brandklipparen-feed-tab";

export function readFeedTab(): FeedTabId {
  try {
    const raw = sessionStorage.getItem(FEED_TAB_STORAGE_KEY);
    return raw === "market" ? "market" : "live";
  } catch {
    return "live";
  }
}

export function FeedTabs({
  active,
  onSelect,
  liveCount,
  marketCount,
}: {
  readonly active: FeedTabId;
  readonly onSelect: (tab: FeedTabId) => void;
  readonly liveCount: string | null;
  readonly marketCount: string | null;
}): JSX.Element {
  const tabs: readonly { readonly id: FeedTabId; readonly label: string; readonly count: string | null }[] = [
    { id: "live", label: "New pairs · on-chain", count: liveCount },
    { id: "market", label: "DexScreener · market", count: marketCount },
  ];
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null;
    if (event.key === "ArrowRight") {
      next = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      next = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tabs.length - 1;
    }
    if (next === null) {
      return;
    }
    event.preventDefault();
    const tab = tabs[next];
    if (tab !== undefined) {
      onSelect(tab.id);
      buttons.current[next]?.focus();
    }
  };

  return (
    <div className="tabs feed-tabs" role="tablist" aria-label="Start page lists">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          role="tab"
          id={`feed-tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`feed-panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          className="tab"
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => move(event, index)}
        >
          {tab.label}
          {tab.count === null ? null : <span className="tab-count numeric"> · {tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
