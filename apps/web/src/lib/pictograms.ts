// Phosphor Console pictograms (UI v2 §2): 24 px grid, inline SVG nodes.
// W-1 ships only the glyphs this unit needs (copy/check/cross for the
// copy icon-button, chain for the topbar network mark); W-2 adds the
// full §2.2 set. Live area 3-21, stroke 1.5 px, colour currentColor.
export type PictoNode =
  | readonly ["path", { readonly d: string }]
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

export type PictogramName = "copy" | "check" | "cross" | "chain";

export const PICTOGRAMS: Record<PictogramName, { readonly label: string; readonly nodes: readonly PictoNode[] }> =
  Object.freeze({
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
    chain: {
      label: "Chain",
      nodes: Object.freeze([
        ["path", { d: "M12 2.75 18.5 12 12 21.25 5.5 12Z" }],
        ["path", { d: "M5.5 12 12 15.25 18.5 12" }],
      ] as const),
    },
  });
