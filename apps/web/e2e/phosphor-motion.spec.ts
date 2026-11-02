// Phosphor Console motion conformance: (a) fully static under reduced
// motion on start and analysis, (b) every running animation in default
// mode touches only opacity/colour/glow with infinite cycles inside
// 1.0-3.2 s and blinks no faster than 1 Hz, (c) no bounding box moves
// during live-list updates except by plain DOM insertion.
// Every REST response is route-mocked; no test reaches the network.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const ANALYZE_FIXTURE = {
  kind: "assessed",
  target: ADDRESS,
  block: 18000000,
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "0.1.0",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 },
  score: 84,
  signals: [
    {
      kind: "capability",
      id: "owner-blacklist",
      risk: "honeypot",
      direction: "raises",
      severity: "high",
      evidence: [{ selector: "0x44337ea1", offset: 2623 }],
    },
  ],
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      {
        text: "The owner can stop you from selling.",
        signalLinks: ["owner-blacklist"],
        temporality: { kind: "can-change" },
      },
    ],
  },
  cantTell: [{ question: "Who holds the liquidity?", dataSource: "liquidity locks" }],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function liveEntry(pairSuffix: string, symbol: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenAddress: `0x5ab1e0000000000000000000000000000000a0${pairSuffix}`,
    symbol,
    name: `${symbol} Token`,
    pairAddress: `0x5ab1e0000000000000000000000000000000b0${pairSuffix}`,
    dex: "Uniswap V2",
    block: 21600002,
    createdAt: 1700000000000,
    blockTimestampMs: 1700000000000 - 45 * 1000,
    ageSeconds: 45,
    initialLiquidityWeth: "2.5",
    state: "done",
    riskBand: "High",
    score: 80,
    ...extra,
  };
}

const LIVE_ANALYZING = liveEntry("cc", "PEND", { state: "analyzing", score: undefined, riskBand: undefined });

async function mockRest(page: Page, getItems: () => Record<string, unknown>[]): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANALYZE_FIXTURE) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: getItems() }),
    });
  });
}

test("phosphor_reduced_motion_is_fully_static_on_start_and_analysis", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockRest(page, () => [liveEntry("aa", "AAA"), liveEntry("bb", "BBB"), LIVE_ANALYZING]);
  await page.goto("/#/");

  await expect(page.getByRole("heading", { name: "Scan before you swap." })).toBeVisible();
  await expect(page.getByText("3 new tokens")).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

    // Count-ups show final values and fills render final under reduce.
  await expect(page.locator(".feed-row")).toHaveCount(3);

  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await expect(page.locator(".score-dial .num")).toHaveText("84");
  await expect(page.locator(".score-dial .tick.lit")).toHaveCount(42);

  // Full interaction script: hover, tooltip focus, signal expand, console.
  await page.locator(".card").first().hover();
  await page.locator('[data-testid="explain-score:combined"]').focus();
  await page.locator('section[aria-label="Why this score"] article details > summary').first().click();
  await page.getByRole("button", { name: "Explain this result" }).click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("phosphor_running_animations_use_only_allowed_properties_with_bounded_cycles", async ({ page }) => {
  await mockRest(page, () => [liveEntry("aa", "AAA"), LIVE_ANALYZING]);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();

  // Let one-shot fills (dial ticks, gauge bars, count-ups, section
  // fades) finish so only the looping inventory pulses remain.
  await page.waitForTimeout(3500);

  const report = await page.evaluate(() => {
    // Motion is opacity/colour/glow only: no height motion and no
    // spatial sweep, including the .detail-head::after pulse.
    const allowed = new Set([
      "opacity",
      "color",
      "background-color",
      "border-color",
      "box-shadow",
      "text-shadow",
      "filter",
    ]);
    const bad: string[] = [];
    const seen: string[] = [];
    for (const animation of document.getAnimations()) {
      const effect = animation.effect;
      if (effect === null || typeof effect !== "object" || !("getKeyframes" in effect)) {
        continue;
      }
      const keyframes = (effect as KeyframeEffect).getKeyframes();
      const timing = (effect as KeyframeEffect).getTiming();
      const iterations = timing.iterations ?? 1;
      const duration = timing.duration;
      const durationMs = typeof duration === "number" ? duration : 0;
      // Computed keyframes use camelCase names and carry computed
      // bookkeeping entries; normalize both before checking.
      const skip = new Set(["offset", "easing", "composite", "computedOffset"]);
      for (const frame of keyframes) {
        for (const property of Object.keys(frame)) {
          if (skip.has(property)) {
            continue;
          }
          const kebab = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          if (!allowed.has(kebab)) {
            bad.push(`animated property ${kebab}`);
          }
        }
      }
      if (animation instanceof CSSTransition) {
        const name = animation.transitionProperty;
        seen.push(`transition:${name}`);
        if (!allowed.has(name)) {
          bad.push(`transition property ${name}`);
        }
      } else {
        seen.push(`animation:${(animation as CSSAnimation).animationName}@${durationMs}msx${String(iterations)}`);
      }
      // Infinite cycles last 1.0-3.2 s: blinks run at most 1 Hz and every
      // pulse or breathing cycle lands in 1.4-3.2 s.
      if (iterations === Infinity && durationMs > 0) {
        if (!(durationMs >= 1000 && durationMs <= 3200)) {
          bad.push(`infinite cycle out of bounds: ${durationMs}ms`);
        }
      }
    }
    return { bad, seen };
  });
  expect(report.bad).toEqual([]);
  // The check is not vacuous: the halo, badge and signal-tag pulses run.
  expect(report.seen.length).toBeGreaterThan(0);

  // The start page pulses too: glass breathing, LIVE square, cursor.
  await page.goto("/#/");
  await expect(page.locator('section[aria-label="New tokens"]').getByText("2 new tokens")).toBeVisible();
  await page.waitForTimeout(1500);
  const start = await page.evaluate(() =>
    document
      .getAnimations()
      .map((animation) =>
        animation instanceof CSSTransition
          ? `transition:${animation.transitionProperty}`
          : `animation:${(animation as CSSAnimation).animationName}`,
      ),
  );
  expect(start.length).toBeGreaterThan(0);
  for (const name of start) {
    expect(name).not.toMatch(/transform|translate|scale|rotate|slide/);
  }
});

test("phosphor_live_list_updates_move_nothing_but_plain_insertion", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let secondPoll = false;
  await mockRest(page, () => (secondPoll ? [liveEntry("cc", "CCC"), liveEntry("aa", "AAA"), liveEntry("bb", "BBB")] : [liveEntry("aa", "AAA"), liveEntry("bb", "BBB")]));
  await page.goto("/#/");
  const live = page.locator('section[aria-label="New tokens"]');
  await expect(live.getByText("2 new tokens")).toBeVisible();
  await expect(live.locator(".feed-row")).toHaveCount(2);

  // Sample row boxes at 4 Hz across the next poll: pre-existing rows may
  // jump once when the insert lands (plain DOM insertion) but must never
  // ramp through intermediate positions the way a slide would.
  secondPoll = true;
  const series = await page.evaluate(
    () =>
      new Promise<Record<string, { x: number[]; y: number[] }>>((resolve) => {
        const frames: Record<string, { x: number[]; y: number[] }> = {};
        let ticks = 0;
        const timer = window.setInterval(() => {
          ticks += 1;
          for (const row of Array.from(document.querySelectorAll(".feed-row"))) {
            const key = row.querySelector("a")?.getAttribute("href") ?? "?";
            const rect = row.getBoundingClientRect();
            if (frames[key] === undefined) {
              frames[key] = { x: [], y: [] };
            }
            frames[key]?.x.push(rect.x);
            frames[key]?.y.push(rect.y);
          }
          if (ticks >= 52) {
            window.clearInterval(timer);
            resolve(frames);
          }
        }, 250);
      }),
  );
  // The insert landed during the window.
  expect(Object.keys(series).length).toBe(3);
  for (const [key, track] of Object.entries(series)) {
    // No horizontal drift on any row, ever.
    expect(new Set(track.x).size, `row ${key} moved horizontally`).toBe(1);
    // Pre-existing rows show at most one step (the insertion jump);
    // a slide animation would ramp through many positions.
    const distinctY = new Set(track.y.map((value) => Math.round(value)));
    expect(distinctY.size, `row ${key} kept moving`).toBeLessThanOrEqual(2);
  }
});

// W-10: loops are capped, so a loaded token page settles with no infinite
// animation. High lamps breathe 2 cycles, cursors rest, the tube shimmer
// settles after 2 breaths; only finite one-shots remain.
test("phosphor_loaded_token_page_has_no_infinite_animation", async ({ page }) => {
  await mockRest(page, () => [liveEntry("aa", "AAA")]);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await page.waitForTimeout(5000);
  const infinite = await page.evaluate(() =>
    document.getAnimations().filter((animation) => {
      const effect = animation.effect;
      if (effect === null || typeof effect !== "object" || !("getKeyframes" in effect)) {
        return false;
      }
      return (effect as KeyframeEffect).getTiming().iterations === Infinity;
    }),
  );
  expect(infinite).toEqual([]);
});

// No motion switch exists anywhere: motion follows only the
// operating-system prefers-reduced-motion setting (static coverage
// lives in reduced-motion.spec.ts under emulation).
test("phosphor_no_motion_switch", async ({ page }) => {
  await mockRest(page, () => [liveEntry("aa", "AAA")]);
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("motion-switch")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Animations" })).toHaveCount(0);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await expect(page.getByTestId("motion-switch")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Animations" })).toHaveCount(0);
});

function registryEntry(id: string, weight: number): Record<string, unknown> {
  const short = id.split(".").pop() ?? id;
  return {
    id,
    kind: "detector",
    weight,
    version: "1.0.0",
    displayName: `${short} detector`,
    description: `Reports ${short}.`,
    frontmatter: { tags: ["holder"], audience: ["holder"], severity: { min: "low", max: "high" } },
  };
}

const DETAIL_ANALYZE = {
  ...ANALYZE_FIXTURE,
  pluginResults: [
    {
      pluginId: "dev.brandklipparen.blacklist",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.blacklist:blacklist",
          title: "Blocked wallets",
          payload: { feature: "blacklist" },
          evidence: [{ selector: "0x44337ea1", offset: 2623 }],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.pause",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [],
    },
  ],
};

const DETAIL_PLUGINS = {
  plugins: [registryEntry("dev.brandklipparen.blacklist", 3), registryEntry("dev.brandklipparen.pause", 1)],
};

async function mockDetailRest(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DETAIL_ANALYZE) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DETAIL_PLUGINS) });
  });
  await page.route("**/v1/proof*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", apiVersion: "v1", codeHash: "0xabc", proofs: [] }),
    });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "none", status: "live", updatedAt: 0, items: [] }),
    });
  });
}

// W-10, M-4: the detail status sentence types into the visible slice, but
// the full text lives in an sr-only twin from the first render, so it is
// present in the accessibility tree at t=0.
test("phosphor_detail_status_sentence_is_in_the_accessibility_tree_at_once", async ({ page }) => {
  await mockDetailRest(page);
  await page.goto(`/#/token/${ADDRESS}/plugins/blacklist`);
  await expect(page.getByRole("heading", { name: "Blacklist" })).toBeVisible();
  const sentence = "The owner can stop chosen wallets from sending tokens.";
  await expect(page.locator(".detail-sentence .sr-only", { hasText: sentence })).toBeAttached();
  await expect(page.getByText(sentence, { exact: true }).first()).toBeAttached();
});
