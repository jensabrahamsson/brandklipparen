// Shared layout contract (UI v2 §7, created in W-1, reused everywhere).
// At each width it checks: no horizontal scroll; every visible control
// meets 44x44 except listed inline text links; no clipped labels; and
// [data-nowrap] content stays on one line. Widths default to the full
// responsive range (320-1440).
import { expect, type Page } from "@playwright/test";

export type LayoutContractOptions = {
  readonly widths?: readonly number[] | undefined;
  // Selectors for inline text links that read as running text and keep
  // an invisible hit area instead of a real 44 px box.
  readonly allow?: readonly string[] | undefined;
};

const CONTROL = "button, a, [role='switch'], summary, input, select, textarea";
const LABEL = "button, .chip, .tile *, dt, dd, .status-word";

export async function assertLayout(
  page: Page,
  options: LayoutContractOptions = {},
): Promise<void> {
  const widths = options.widths ?? [320, 390, 768, 1440];
  const allow = options.allow ?? [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });

    // 1. No horizontal scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 1) {
      const offenders = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        return Array.from(document.querySelectorAll("*"))
          .map((element) => {
            const node = element as HTMLElement;
            const rect = node.getBoundingClientRect();
            return { node, rect };
          })
          .filter(({ rect }) => rect.width > 0 && (rect.right > limit + 1 || rect.left < -1))
          .sort((a, b) => b.rect.right - a.rect.right)
          .slice(0, 6)
          .map(
            ({ node, rect }) =>
              `${node.tagName.toLowerCase()}.${(node.className as string).toString().split(" ").join(".")} left=${Math.round(rect.left)} right=${Math.round(rect.right)} w=${Math.round(rect.width)} text=${(node.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}`,
          );
      });
      expect(overflow, `horizontal overflow at ${width}px: ${offenders.join(" | ")}`).toBeLessThanOrEqual(1);
    }

    // 2. Every visible control meets 44x44, except allowlisted links.
    const small = await page.evaluate(
      ({ control, allowlist }: { control: string; allowlist: readonly string[] }) =>
        Array.from(document.querySelectorAll(control))
          .filter((element) => {
            const node = element as HTMLElement;
            if (node.closest(".sr-only") !== null) {
              return false;
            }
            if (node.getAttribute("aria-hidden") === "true") {
              return false;
            }
            for (const selector of allowlist) {
              if (node.matches(selector)) {
                return false;
              }
            }
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.x <= -8000 || rect.y <= -20000) {
              return false;
            }
            const style = getComputedStyle(node);
            if (style.visibility === "hidden" || style.display === "none") {
              return false;
            }
            return rect.width < 44 || rect.height < 44;
          })
          .map((element) => {
            const node = element as HTMLElement;
            const rect = node.getBoundingClientRect();
            return `${node.tagName.toLowerCase()}.${(node.className as string)
              .toString()
              .split(" ")
              .join(".")} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
          }),
      { control: CONTROL, allowlist: allow },
    );
    expect(small, `small controls at ${width}px`).toEqual([]);

    // 3. No clipped labels.
    const clipped = await page.evaluate((label: string) => {
      const hits: string[] = [];
      for (const element of Array.from(document.querySelectorAll(label))) {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        // Deliberate single-line truncation (U-8 compact tile rows):
        // ellipsis with the full text in the parent link's accessible
        // name is not accidental clipping.
        const truncation = getComputedStyle(node);
        if (truncation.textOverflow === "ellipsis" && truncation.overflow !== "visible") {
          continue;
        }
        if (node.scrollWidth > node.clientWidth + 1) {
          hits.push(`${node.tagName.toLowerCase()}.${(node.className as string).toString().split(" ").join(".")}`);
        }
      }
      return hits;
    }, LABEL);
    expect(clipped, `clipped labels at ${width}px`).toEqual([]);

    // 4. [data-nowrap] content (ages, short fact values, status words)
    // stays on one line.
    const wrapped = await page.evaluate(() => {
      const hits: string[] = [];
      for (const element of Array.from(document.querySelectorAll("[data-nowrap]"))) {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
        if (Number.isFinite(lineHeight) && rect.height > lineHeight * 1.6) {
          hits.push(`${node.tagName.toLowerCase()}.${(node.className as string).toString().split(" ").join(".")}`);
        }
      }
      return hits;
    });
    expect(wrapped, `wrapped nowrap content at ${width}px`).toEqual([]);
  }
}
