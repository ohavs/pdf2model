# Design

Recorded from the built interface, not from intention. Change the code and update this file.

## World

**The architectural model shop.** A plan is a sheet you cut a model out of. The sheet stays lit
on a mat for the whole session and the model stands beside it — the two are never separate screens.

Deliberately refused, because they are what this category always ships:

- Blueprint costume: cyan hairlines on navy, drafting grid as wallpaper, sepia parchment.
- Warm editorial: cream ground, high-contrast serif display, terracotta accent.
- Dark technical tool: near-black with a neon accent and glowing edges.

Mode is **Operate** throughout. There is no marketing surface. The workbench is the front door,
and the empty state carries the whole explanation in four lines.

## Color

Strategy: **Restrained.** Warm neutrals carry every surface; one accent carries state.

| Token | Value | Job |
|---|---|---|
| `--mat` | `#8C877C` | Cutting mat. The canvas surround only. Gives the white sheet its contrast. |
| `--board` | `#E8E4DC` | Museum board. Buttons, popovers, panels. |
| `--board-2` | `#DBD6CB` | Deeper board. Topbar, instrument rail. |
| `--board-3` | `#CBC5B8` | Pressed state. |
| `--sheet` | `#FFFFFF` | The user's PDF. Never tinted, only dimmed to 34% once tracing starts. |
| `--ink` | `#23211E` | Graphite. All body text, wall linework, status bar ground. |
| `--ink-2` | `#5C574E` | Secondary text, inactive icons. |
| `--ink-3` | `#8A8478` | Tertiary — hints, timestamps, units. |
| `--line` | `#B9B2A4` | Borders. |
| `--line-soft` | `#CFC9BC` | Interior rules inside the sheet. |
| `--rule` | `#E8B923` | **Cutting-rule yellow.** |
| `--blade` | `#B23A2E` | Destruction and failure only. |
| `--ok` | `#4A7A46` | Save confirmation only. |

**The yellow rule.** `--rule` is a fill, never a text color, because yellow text on light board
fails contrast. Text on yellow is always `--ink` — 9.2:1, the same relationship as black markings
on a real steel rule. It appears in exactly four places: the active instrument, the current
selection, the live measurement being drawn, and the scale chip while scale is still unset.
Nothing decorative is yellow. If a fifth use appears, one of them is wrong.

## Type

**Archivo** for everything. One family, per Operate discipline — no display/body pairing.

**Archivo Narrow** on every number that describes physical space: wall dimension strings, the
scale readout, the length input, page numbers, timestamps. This mirrors how dimensions are
lettered on real drawings, and it keeps long strings inside short walls.

`font-variant-numeric: tabular-nums` is on the `.num` class and every numeric input. Digits must
not shift width while a measurement updates.

Fixed rem-adjacent scale, not fluid: 9.5px uppercase labels (0.1em tracking), 11.5–12px controls,
13px base, 19px on the single h1 in the empty state. Ratio stays near 1.15.

## Layout

Three fixed rows: 44px topbar, flexible body, 26px status bar.

Body is a three-column grid whose middle column carries all the state:
`1fr / 380px / 46px` normally, `1fr / 0 / 46px` before the model exists, `1fr / 62% / 46px`
when expanded. The plan is never smaller than the model; the sheet is the subject.

Instruments live in a 46px right rail, ordered by the actual sequence of work — select, scale,
wall, door, window, then raise, dimensions, export, then undo and clear pinned to the bottom.
Disabled until their precondition is met, which is how the interface teaches the order.

Below 820px the model pane is removed rather than stacked. Tracing needs a pointer and a large
canvas; a phone gets the sheet and nothing else.

## Components

Every control ships default, hover, active, disabled, and focus-visible. Focus is a 2px `--ink`
outline at 1px offset, on canvas handles as well as buttons.

- **Segmented controls** (Model/Render, Orbit/Eye level) use `aria-pressed`, not a class.
- **Popovers** are anchored to the rail and closed by outside click or Escape. No modals — nothing
  in this tool needs protected focus.
- **Empty states teach.** The plan pane opens with the four-step sequence and a real button. The
  model pane says what is missing and how many walls it needs.
- **Toast** for outcomes that leave the screen (a file saved). The status bar carries everything
  continuous.

## Motion

One authored moment: **the rise.** Walls scale from zero to full height on an exponential
ease-out, `1 - (1-t)^3.2` over roughly 35 frames. It is the only choreographed animation in the
product and it exists because it explains the mechanism in one second.

Everything else is 120ms state feedback. `prefers-reduced-motion` collapses the rise to a cut.

## Copy

Plain verbs, sentence case, second person. Controls name their action and keep that name through
the flow. Errors name the problem and the recovery — "That line is too short to measure from.
Draw a longer one." Never an apology, never a vague failure.

Numbers are metric and never invented: a dimension appears only after the user has calibrated,
and the scale chip stays yellow and reads "not set" until then.

## Known gaps

Recorded honestly so the next pass starts from truth.

- **No finish review.** This build has not been inspected in a browser at desktop and mobile
  widths. Contrast ratios are calculated, not measured on the render.
- Floors are correct only for closed traced loops; an open trace falls back to a bounding slab.
- Materials are procedural canvas textures, not a scanned PBR library.
- Single storey. No furniture. No AI rendering path yet.
