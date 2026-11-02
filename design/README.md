# Brandklipparen: design

## Shipped design: Phosphor Console

The shipped web UI (`apps/web/`) is the Phosphor Console: a green-phosphor
CRT terminal. This section describes the shipped system; the sketches and
v1 notes below are archived history and do not describe the app.

- **Colour**: void `#010402` background, glass `#03110A` surfaces, phosphor
  `#8DFFB6` body text and phosphor-hi `#D6FFE6` headings (see `--phosphor`
  and `--phosphor-hi` in `apps/web/src/styles.css`). Risk colour follows
  the score only and never carries meaning alone: badges show number and
  word together.
- **Type**: monospace throughout (`ui-monospace`, SF Mono, Menlo, Consolas).
  Tabular figures for scores and percentages.
- **Hierarchy (3 levels)**: token page verdict hero (score ring, meaning
  sentence, owner-powers strip, risk gauges), then the plugin board
  ("What we checked"), then a detector detail page per check with proof,
  evidence and code. The start page is search first, then live token feeds.
- **Motion**: blink or pulse/glow only, under 3 flashes per second, never
  movement (no transform, translate, slide, scale or height motion). Under
  `prefers-reduced-motion` everything is static.
- **Accessibility**: WCAG 2.2 AA. Touch targets at least 44x44 CSS px on
  all widths. Token addresses stay in full EIP-55 form with a copy button.
- **Scores**: 0-29 Low, 30-59 Elevated, 60-100 High.

## Archive: v1 sketches (not shipped)

Design sketches for the hackathon. Nothing here is code. The images are static SVG files that open directly in a browser.
All data in the sketches is made up: tokens, addresses, selectors and statistics.

```
design/
├── README.md
├── logo/
│   ├── a-vakt.svg            proposal A (recommended)
│   ├── b-springaren.svg      proposal B
│   ├── c-bytemanke.svg       proposal C
│   └── overview.svg          all three, lockup, light variant, small sizes
└── skisser/
    ├── 00-palette-and-components.svg
    ├── 01-homepage.svg
    ├── 02-token-page.svg
    └── 03-timeline.svg
```

## Identity

Brandklipparen was Charles XII's horse. We borrow the horse's qualities, not the history: **fast, vigilant, reliable**.
A courser that carries you through dangerous terrain and senses danger before you see it. That is exactly what the product does
at deploy: it reads the bytecode before the market has had time to react.

No crowns, no royal pomp, no flags. The Swedish touch is in the simplicity, in the muted fell-blue tone and in
a single detail in grain gold (the horse's eye).

### Logo proposals

| | Proposal | Idea | Strength | Weakness |
|---|---|---|---|---|
| A | **Vakt** | Faceted horse head in profile, pricked ear, two blue tones, eye in grain gold | Calmest, timeless, holds down to 16 px | Least narrative |
| B | **Springaren** | The knight in chess, called *springare* in Swedish | Double meaning: the knight jumps over obstacles, you jump over traps | Chess pieces are a common motif in crypto |
| C | **Bytemanke** | Same head as A, but the mane is rows of bytecode | Says what the product does | Detailed, the mane disappears below 24 px |

**Recommendation: A.** It is clearest in favicons, in Telegram notifications and in Muse answers where the mark gets small.
C works as an illustration on the landing page or in the pitch. All marks face right, forward in time,
in the same direction as the timeline.

The wordmark is set `brandklipparen` in lowercase, Inter 600, with slightly tight tracking. Lowercase feels more modern and less
shouty than uppercase, and the long Swedish word reads more easily.

### Tagline (English)

1. **Senses the rug before you see it.** (recommended, ties to the horse sensing danger)
2. Read the bytecode. Ride clear.
3. Risk, straight from the bytecode.
4. Know before you ape.
5. Steady footing in rough markets.

## Colour palette

Dark base, one calm blue for the brand and risk colours used only for risk.

| Role | Name | Hex |
|---|---|---|
| Background | Night | `#0E1116` |
| Cards, surfaces | Surface | `#161B22` |
| Edges, dividers | Edge | `#262D38` |
| Primary text | Text | `#E6EAF0` |
| Secondary text | Text 2 | `#8B95A3` |
| Muted text, axes | Text 3 | `#5E6876` |
| Brand, links, focus | Fell blue | `#7E9CC2` |
| Brand, shadow tone | Deep fell blue | `#4E6A8F` |
| Swedish detail | Grain gold | `#D4B36A` |
| Low risk (0–29) | Green | `#3FB97F` (background `#16291F`) |
| Elevated risk (30–59) | Orange | `#E5A13A` (background `#2E2414`) |
| High risk (60–100) | Red | `#E5534B` (background `#321A1B`) |
| Cannot tell | Hatched grey | `#3A4250` (diagonal hatching) |

Rules:
- Risk colour always follows the score and never means anything else. Buttons and links are fell blue, never green.
- Grain gold appears only in the logo and in single details, never in data. Otherwise it can be confused with orange risk.
- Colour is never the sole carrier of information: badges carry both number and word (`84 High`).
- Light variant of the logo: deep fell blue `#4E6A8F` / `#2E4566` and darker gold `#B8913A` on `#F4F2EC`.

## Typography and tone

- **Inter** (600 headings, 400 body) for everything meant to be read. Tabular figures everywhere so scores and percentages
  stand still when they update.
- **JetBrains Mono** for everything meant to be copied: addresses, selectors, PC offsets and decompiled code.
- Sizes: 40 hero, 22–28 page heading, 17–20 section, 15 body, 12–13 metadata.

Tone: calm, factual and professional, like an experienced colleague pointing at the problem without raising their voice.
- The answer comes first: `Likely honeypot: the owner can stop you from selling.` The details come after.
- Active voice and everyday words: "the owner can", not "privileged role detected".
- At most two sentences per explanation. No exclamation marks, emojis or scare words like "SCAM!!".
- We are honest about uncertainty: probabilities are calibrated, and what we cannot know is stated explicitly in its own field.
- Product copy is in English, since the audience is international.

## Component principles

1. **Answer on top, evidence below.** Every view goes from conclusion (score, one sentence) to detail (signal, selector, code).
   A trader should grasp the risk in three seconds and be able to verify it in thirty.
2. **Risk badge**: rounded pill with tinted background, bold number first and word after. Same badge in list, heading and API response.
3. **Gauge**: half-circle per risk type (rug pull, honeypot, bot-pump). Percentage in the middle and one line saying *why*.
   No needle, no gradients: just an arc in the risk colour.
4. **Signal row**: coloured left border (impact direction), plain-language title, risk type as tag and impact in
   points on the right (`+24`, `−5`). Expanded it shows three layers: selectors → decompiled snippet with marked line →
   explanation from Muse. Signals that lower the risk are shown too, so the score reads both ways.
5. **"Can't tell" panel**: dashed frame and hatching, never green or red. It does not count toward the score and says so.
6. **Muse attribution**: a small fell-blue dot and the word *Muse* beside every generated explanation. It separates
   machine explanation from bytecode facts.
7. **Surfaces**: no shadows, just two levels of surfaces and 1 px edges. Corner radius 16 for cards, 14 for rows, 8–10 for
   buttons. Spacing in 4 px steps.
8. **Mono means copyable**: everything in monospace can be clicked to copy.

## The sketches

### 00 · Palette and components
Reference sheet for colours, badges, signal impact and type scale, so everyone builds with the same blocks.

### 01 · Landing page
DEXTools opens with a swarm of numbers. We open with a single question and a search field, since the main flow is
"paste an address". Below it sits the **Just deployed** list, newest token on top with a short
marker. Each row shows the aggregate score, the three probabilities with minibar and the most important signal in plain text,
so the list scans without clicking. Filter chips for high and low risk and unverified contracts only.

### 02 · Token page
The core of the demo. Top to bottom:
- **Aggregate score** (ring 0–100) beside one sentence saying what it means and two lines from Muse. Below it the
  analysis time and a calibration line ("of earlier tokens scoring 80–89 …"), so the number means something.
- **Three gauges** for rug pull, honeypot and bot-pump, each with signal count and one cause.
- **Signal list**, sorted by impact. The first is expanded and shows the full evidence chain: selectors with
  PC offset, decompiled code with the decisive line marked and a plain-text explanation. Then the
  buttons "Copy evidence" and "Open in bytecode".
- **What bytecode alone can't tell you**: liquidity locks, who holds the owner key, intent, unknown external contracts,
  team and wallet clusters. The panel makes us more credible, since it shows where the model's boundary runs.
- The sidebar holds contract facts, a minigraph leading to the timeline, **similar bytecode** (what happened to
  earlier contracts with the same layout) and the API/MCP call for anyone wanting the result in their bot.

### 03 · Timeline
Shows how the risk has changed since deploy. The example is a token that looked innocent at deploy (41) and became a
honeypot after a proxy upgrade 11 minutes later (78 → 91 → 84). Top to bottom:
- **Step graph** of the score with the risk zones as faint bands and numbered event markers. Steps instead of a
  smoothed curve, since risk changes at discrete events.
- **Three small graphs** for the sub-probabilities, so you see *which* risk moved.
- **Event log** tied to the markers. Each row shows source (bytecode, storage or pool event),
  change and new score. The largest change carries an explanation from Muse.

The timeline also answers the demo question "how far do you get with bytecode alone?": at deploy you get far,
and when the code is replaced we see it immediately.
