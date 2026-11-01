// Phosphor Console pictograms (UI v2 §2.1-§2.2): 24 px grid, inline
// SVG nodes. Live area 3-21, stroke 1.5 px, colour currentColor.
// Elements marked fill use fill="currentColor" with no stroke.
export type PictoNode =
  | readonly ["path", { readonly d: string; readonly fill?: boolean | undefined }]
  | readonly [
      "circle",
      {
        readonly cx: number;
        readonly cy: number;
        readonly r: number;
        readonly fill?: boolean | undefined;
        readonly pathLength?: string | undefined;
        readonly dash?: string | undefined;
      },
    ]
  | readonly [
      "rect",
      {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
        readonly rx?: number | undefined;
      },
    ];

export type PictogramName =
  | "chain"
  | "contract"
  | "pair"
  | "dex"
  | "age"
  | "liquidity"
  | "proxy"
  | "direct"
  | "hash"
  | "owner"
  | "renounced"
  | "pause"
  | "blacklist"
  | "mint"
  | "fee"
  | "limits"
  | "sellblock"
  | "hooks"
  | "upgrade"
  | "callout"
  | "capability"
  | "decompiler"
  | "clone"
  | "tangle"
  | "block"
  | "model"
  | "found"
  | "notfound"
  | "extended"
  | "canttell"
  | "error"
  | "notrun"
  | "muse"
  | "fn"
  | "partial"
  | "verified"
  | "source"
  | "note"
  | "copy"
  | "check"
  | "cross"
  | "chevron-right"
  | "chevron-down"
  | "back"
  | "expert"
  | "link"
  | "volume"
  | "market";

export const PICTOGRAMS: Record<PictogramName, { readonly label: string; readonly nodes: readonly PictoNode[] }> =
  Object.freeze({
    chain: {
      label: "Chain",
      nodes: Object.freeze([
        ["path", { d: "M12 2.75 18.5 12 12 21.25 5.5 12Z" }],
        ["path", { d: "M5.5 12 12 15.25 18.5 12" }],
      ] as const),
    },
    contract: {
      label: "Contract",
      nodes: Object.freeze([
        ["path", { d: "M6 2.75h8.25L18 6.5v14.75H6Z" }],
        ["path", { d: "M14 2.75v4h4" }],
        ["path", { d: "m10 11.5-2 2 2 2" }],
        ["path", { d: "m14 11.5 2 2-2 2" }],
      ] as const),
    },
    pair: {
      label: "Pair",
      nodes: Object.freeze([
        ["circle", { cx: 9, cy: 12, r: 5.25 }],
        ["circle", { cx: 15, cy: 12, r: 5.25 }],
      ] as const),
    },
    dex: {
      label: "DEX",
      nodes: Object.freeze([
        ["path", { d: "M4 8.5h15" }],
        ["path", { d: "m15.5 5 3.5 3.5-3.5 3.5" }],
        ["path", { d: "M20 15.5H5" }],
        ["path", { d: "m8.5 12-3.5 3.5 3.5 3.5" }],
      ] as const),
    },
    age: {
      label: "First seen",
      nodes: Object.freeze([
        ["circle", { cx: 12, cy: 12, r: 8.25 }],
        ["path", { d: "M12 7.5V12l3 2" }],
      ] as const),
    },
    liquidity: {
      label: "Liquidity",
      nodes: Object.freeze([
        ["path", { d: "M12 3.25s-6 6.9-6 10.75a6 6 0 0 0 12 0c0-3.85-6-10.75-6-10.75Z" }],
        ["path", { d: "M8.75 15.25h6.5" }],
      ] as const),
    },
    proxy: {
      label: "Proxy",
      nodes: Object.freeze([
        ["rect", { x: 2.75, y: 8, width: 6.5, height: 8, rx: 1 }],
        ["rect", { x: 14.75, y: 8, width: 6.5, height: 8, rx: 1 }],
        ["path", { d: "M9.25 12h4" }],
        ["path", { d: "m12.75 10 2 2-2 2" }],
      ] as const),
    },
    direct: {
      label: "No proxy",
      nodes: Object.freeze([
        ["rect", { x: 7, y: 6, width: 10, height: 12, rx: 1 }],
        ["path", { d: "m9.75 12.25 1.6 1.6 3-3.35" }],
      ] as const),
    },
    hash: {
      label: "Code hash",
      nodes: Object.freeze([
        ["path", { d: "M9.5 3.5 7.5 20.5" }],
        ["path", { d: "m16.5 3.5-2 17" }],
        ["path", { d: "M4.5 9h15.5" }],
        ["path", { d: "M4 15h15.5" }],
      ] as const),
    },
    owner: {
      label: "Owner",
      nodes: Object.freeze([
        ["circle", { cx: 7.5, cy: 12, r: 3.75 }],
        ["path", { d: "M11.25 12h9.25" }],
        ["path", { d: "M17.5 12v3" }],
        ["path", { d: "M20.5 12v2.25" }],
      ] as const),
    },
    renounced: {
      label: "Renounced",
      nodes: Object.freeze([
        ["circle", { cx: 7.5, cy: 12, r: 3.75 }],
        ["path", { d: "M11.25 12h9.25" }],
        ["path", { d: "M17.5 12v3" }],
        ["path", { d: "M20.5 12v2.25" }],
        ["path", { d: "M3.5 3.5l17 17" }],
      ] as const),
    },
    pause: {
      label: "Pause",
      nodes: Object.freeze([
        ["rect", { x: 6.75, y: 5, width: 3.5, height: 14, rx: 1 }],
        ["rect", { x: 13.75, y: 5, width: 3.5, height: 14, rx: 1 }],
      ] as const),
    },
    blacklist: {
      label: "Blacklist",
      nodes: Object.freeze([
        ["path", { d: "M4 6.5h10" }],
        ["path", { d: "M4 11.5h10" }],
        ["path", { d: "M4 16.5h6" }],
        ["path", { d: "m14.5 14.5 5 5" }],
        ["path", { d: "m19.5 14.5-5 5" }],
      ] as const),
    },
    mint: {
      label: "Mint",
      nodes: Object.freeze([
        ["circle", { cx: 12, cy: 12, r: 8.25 }],
        ["path", { d: "M12 8v8" }],
        ["path", { d: "M8 12h8" }],
      ] as const),
    },
    fee: {
      label: "Fee",
      nodes: Object.freeze([
        ["circle", { cx: 7.5, cy: 7.5, r: 2.25 }],
        ["circle", { cx: 16.5, cy: 16.5, r: 2.25 }],
        ["path", { d: "M18.5 5.5 5.5 18.5" }],
      ] as const),
    },
    limits: {
      label: "Limits",
      nodes: Object.freeze([
        ["path", { d: "M4 4.75h16" }],
        ["path", { d: "M12 20V9" }],
        ["path", { d: "m8 12.5 4-4 4 4" }],
      ] as const),
    },
    sellblock: {
      label: "Sell block",
      nodes: Object.freeze([
        ["path", { d: "M3 12h11" }],
        ["path", { d: "m10.5 8.5 3.5 3.5-3.5 3.5" }],
        ["path", { d: "M18.5 4.5v15" }],
      ] as const),
    },
    hooks: {
      label: "Hooks",
      nodes: Object.freeze([
        ["path", { d: "M14 3.5V14a4 4 0 0 1-8 0v-1.5" }],
        ["path", { d: "m4 14.5 2-2 2 2" }],
      ] as const),
    },
    upgrade: {
      label: "Upgrade",
      nodes: Object.freeze([
        ["path", { d: "M12 15.5V3.75" }],
        ["path", { d: "m7.75 8 4.25-4.25L16.25 8" }],
        ["path", { d: "M4 13.5v6.75h16V13.5" }],
      ] as const),
    },
    callout: {
      label: "Calls out",
      nodes: Object.freeze([
        ["path", { d: "M13.5 3.75h6.75v6.75" }],
        ["path", { d: "M20.25 3.75 11 13" }],
        ["path", { d: "M18 14v6.25H3.75V6H10" }],
      ] as const),
    },
    capability: {
      label: "Capability",
      nodes: Object.freeze([["path", { d: "M13 3 5.5 13.5H12L11 21l7.5-10.5H12Z" }]] as const),
    },
    decompiler: {
      label: "Decompiler",
      nodes: Object.freeze([
        ["path", { d: "m8 7-5 5 5 5" }],
        ["path", { d: "m16 7 5 5-5 5" }],
        ["path", { d: "M13.75 4.5 10.25 19.5" }],
      ] as const),
    },
    clone: {
      label: "Clone match",
      nodes: Object.freeze([
        ["rect", { x: 3.5, y: 6, width: 7, height: 12, rx: 1 }],
        ["rect", { x: 13.5, y: 6, width: 7, height: 12, rx: 1 }],
        ["path", { d: "M6 10h2M6 14h2M16 10h2M16 14h2" }],
      ] as const),
    },
    tangle: {
      label: "Hard to read",
      nodes: Object.freeze([["path", { d: "M3.5 12c2-5 5-5 6 0s4 5 6 0 3-4 5-2" }]] as const),
    },
    block: {
      label: "Block",
      nodes: Object.freeze([
        ["path", { d: "M12 3 19.75 7.5v9L12 21l-7.75-4.5v-9Z" }],
        ["path", { d: "M4.25 7.5 12 12l7.75-4.5" }],
        ["path", { d: "M12 12v9" }],
      ] as const),
    },
    model: {
      label: "Model",
      nodes: Object.freeze([
        ["path", { d: "M12 4 20.5 8.5 12 13 3.5 8.5Z" }],
        ["path", { d: "m3.5 12.5 8.5 4.5 8.5-4.5" }],
        ["path", { d: "m3.5 16.5 8.5 4.5 8.5-4.5" }],
      ] as const),
    },
    found: {
      label: "Found",
      nodes: Object.freeze([
        ["circle", { cx: 12, cy: 12, r: 8.25 }],
        ["circle", { cx: 12, cy: 12, r: 3.5, fill: true }],
      ] as const),
    },
    notfound: {
      label: "Not found",
      nodes: Object.freeze([
        ["circle", { cx: 12, cy: 12, r: 8.25 }],
        ["path", { d: "M8.5 12h7" }],
      ] as const),
    },
    extended: {
      label: "Not in score",
      nodes: Object.freeze([
        ["circle", { cx: 12, cy: 12, r: 8.25, pathLength: "40", dash: "2 2" }],
        ["circle", { cx: 12, cy: 12, r: 3.5, fill: true }],
      ] as const),
    },
    canttell: {
      label: "Can't tell",
      nodes: Object.freeze([
        ["circle", { cx: 12, cy: 12, r: 8.25, pathLength: "40", dash: "2 2" }],
        ["path", { d: "M9.75 9.75a2.25 2.25 0 1 1 3.1 2.08c-.5.2-.85.68-.85 1.22v.7" }],
        ["circle", { cx: 12, cy: 16.75, r: 0.9, fill: true }],
      ] as const),
    },
    error: {
      label: "Error",
      nodes: Object.freeze([
        ["path", { d: "M12 3.5 21 19.5H3Z" }],
        ["path", { d: "M12 9.5V14" }],
        ["circle", { cx: 12, cy: 16.9, r: 0.9, fill: true }],
      ] as const),
    },
    notrun: {
      label: "Not run",
      nodes: Object.freeze([
        ["circle", { cx: 12, cy: 12, r: 8.25, pathLength: "40", dash: "2 2" }],
        ["path", { d: "M8.5 12h7" }],
      ] as const),
    },
    muse: {
      label: "Muse",
      nodes: Object.freeze([
        ["path", { d: "M12 3.5Q13 11 20.5 12 13 13 12 20.5 11 13 3.5 12 11 11 12 3.5Z" }],
        ["path", { d: "M19 3.5v3" }],
        ["path", { d: "M17.5 5h3" }],
      ] as const),
    },
    fn: {
      label: "Function",
      nodes: Object.freeze([
        ["path", { d: "M10 20c2 0 2.5-1.5 3-4l2-10c.5-2.5 1-3 3-3" }],
        ["path", { d: "M8.5 10h8" }],
      ] as const),
    },
    partial: {
      label: "Partial",
      nodes: Object.freeze([
        ["circle", { cx: 12, cy: 12, r: 8.25 }],
        ["path", { d: "M12 3.75v16.5" }],
        ["path", { d: "M12 3.75a8.25 8.25 0 0 1 0 16.5Z", fill: true }],
      ] as const),
    },
    verified: {
      label: "Verified",
      nodes: Object.freeze([
        ["path", { d: "M12 3 19 6v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6Z" }],
        ["path", { d: "m9 12 2.2 2.2 4.3-4.2" }],
      ] as const),
    },
    source: {
      label: "Source",
      nodes: Object.freeze([
        ["path", { d: "M6 2.75h8.25L18 6.5v14.75H6Z" }],
        ["path", { d: "M14 2.75v4h4" }],
        ["path", { d: "M9 8.5h2" }],
        ["path", { d: "M9 12h6" }],
        ["path", { d: "M9 15.5h6" }],
      ] as const),
    },
    note: {
      label: "Note",
      nodes: Object.freeze([
        ["path", { d: "M12 3.5Q13 11 20.5 12 13 13 12 20.5 11 13 3.5 12 11 11 12 3.5Z" }],
        ["path", { d: "M19 3.5v3" }],
        ["path", { d: "M17.5 5h3" }],
      ] as const),
    },
    copy: {
      label: "Copy",
      nodes: Object.freeze([
        ["rect", { x: 8.75, y: 8.75, width: 11.5, height: 11.5, rx: 1.5 }],
        ["path", { d: "M15.25 8.75V5.25a1.5 1.5 0 0 0-1.5-1.5h-8.5a1.5 1.5 0 0 0-1.5 1.5v8.5a1.5 1.5 0 0 0 1.5 1.5h3.5" }],
      ] as const),
    },
    check: {
      label: "Copied",
      nodes: Object.freeze([["path", { d: "m5 12.5 4.5 4.5L19 7.5" }]] as const),
    },
    cross: {
      label: "Copy failed",
      nodes: Object.freeze([["path", { d: "m7 7 10 10M17 7 7 17" }]] as const),
    },
    "chevron-right": {
      label: "Collapsed",
      nodes: Object.freeze([["path", { d: "m9 5.5 6.5 6.5L9 18.5" }]] as const),
    },
    "chevron-down": {
      label: "Expanded",
      nodes: Object.freeze([["path", { d: "M5.5 9 12 15.5 18.5 9" }]] as const),
    },
    back: {
      label: "Back",
      nodes: Object.freeze([
        ["path", { d: "M19.5 12h-15" }],
        ["path", { d: "m10.5 6-6 6 6 6" }],
      ] as const),
    },
    expert: {
      label: "Expert view",
      nodes: Object.freeze([
        ["path", { d: "M4 7h10M18 7h2M4 17h4M12 17h8" }],
        ["circle", { cx: 16, cy: 7, r: 2 }],
        ["circle", { cx: 10, cy: 17, r: 2 }],
      ] as const),
    },
    link: {
      label: "Copy link",
      nodes: Object.freeze([
        ["path", { d: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" }],
        ["path", { d: "M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" }],
      ] as const),
    },
    volume: {
      label: "Volume",
      nodes: Object.freeze([
        ["path", { d: "M5 20v-6" }],
        ["path", { d: "M10 20V8" }],
        ["path", { d: "M15 20v-9" }],
        ["path", { d: "M20 20V5" }],
      ] as const),
    },
    market: {
      label: "Market",
      nodes: Object.freeze([
        ["path", { d: "M7 3.5v17" }],
        ["rect", { x: 5, y: 8, width: 4, height: 7, rx: 0.5 }],
        ["path", { d: "M17 3.5v17" }],
        ["rect", { x: 15, y: 6, width: 4, height: 9, rx: 0.5 }],
      ] as const),
    },
  });
