// Phosphor Console pictogram renderer (UI v2 §2.1): decorative inline
// SVG only (aria-hidden, never a <title>), colour currentColor, 1.5 px
// round strokes on the 24 px grid. Meaning always rides in adjacent
// text or the control's accessible name, never in the glyph alone.
import type { JSX } from "react";
import { PICTOGRAMS, type PictogramName } from "../lib/pictograms.ts";

export function Pictogram({
  name,
  size = 24,
}: {
  readonly name: PictogramName;
  readonly size?: number | undefined;
}): JSX.Element {
  const glyph = PICTOGRAMS[name];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect={size >= 32 ? "non-scaling-stroke" : undefined}
    >
      {glyph.nodes.map((node, index) => {
        if (node[0] === "path") {
          return node[1].fill === true ? (
            <path key={index} d={node[1].d} fill="currentColor" stroke="none" />
          ) : (
            <path key={index} d={node[1].d} />
          );
        }
        if (node[0] === "circle") {
          const attrs = node[1];
          return attrs.fill === true ? (
            <circle key={index} cx={attrs.cx} cy={attrs.cy} r={attrs.r} fill="currentColor" stroke="none" />
          ) : (
            <circle
              key={index}
              cx={attrs.cx}
              cy={attrs.cy}
              r={attrs.r}
              pathLength={attrs.pathLength}
              strokeDasharray={attrs.dash}
            />
          );
        }
        const attrs = node[1];
        return <rect key={index} x={attrs.x} y={attrs.y} width={attrs.width} height={attrs.height} rx={attrs.rx} />;
      })}
    </svg>
  );
}
