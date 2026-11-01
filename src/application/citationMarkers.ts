// Citation markers for overlay text. Model entries carry their evidence
// in a structured citations list beside the text; the web renders one
// evidence chip per `[E:<id>]` marker inside the text. Kept entries get
// one marker per validated citation appended here, deterministically,
// so a cited claim always renders its chips even when the model text
// carries no marker. Markers already present in the text (in any form
// the web parser tolerates) are not repeated. Scores and evidence are
// untouched: this only rewrites the advisory overlay text.

const MARKER_PATTERN = /\[\s*[Ee]\s*:\s*([^\]]+)\]/g;

function citedIdsInText(text: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (let match = MARKER_PATTERN.exec(text); match !== null; match = MARKER_PATTERN.exec(text)) {
    const inner = match[1] ?? "";
    for (const entry of inner.split(/[,;]/)) {
      const id = entry.trim().replace(/^`+|`+$/g, "").trim();
      if (id.length > 0) {
        ids.add(id);
      }
    }
  }
  return ids;
}

export function withCitationMarkers(text: string, citations: readonly string[]): string {
  const present = citedIdsInText(text);
  const missing = [...new Set(citations)].filter((id) => !present.has(id));
  if (missing.length === 0) {
    return text;
  }
  const markers = missing.map((id) => `[E:${id}]`).join(" ");
  return `${text} ${markers}`;
}
