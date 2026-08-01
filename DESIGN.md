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
| `--mat` | `#807B71` | Cutting mat. The canvas surround only. Gives the white sheet its contrast. |
| `--panel` | `#FBF9F5` | Museum board. Topbar, rail, popovers, buttons. |
| `--panel-2` | `#F1EDE5` | Recessed board. Hover grounds, the model pane's empty state. |
| `--panel-3` | `#E4DFD5` | Chips and segmented-control troughs. |
| `--panel-4` | `#D6D0C4` | The stage ground, matched to `scene.background`. |
| `--sheet` | `#FFFFFF` | The user's PDF. Never tinted, only dimmed to 42% once a proposal or a tracing sits on it. |
| `--ink` | `#22201D` | Graphite. All body text, wall linework. |
| `--ink-2` | `#55504A` | Every secondary text there is. |
| `--ink-3` | `#8A8478` | **Linework only, never text.** Door swing arcs, the empty-state glyph. |
| `--line` | `#DDD7CB` | Structural borders. |
| `--line-2` | `#C6BFB1` | Control borders. |
| `--rule` | `#E8B923` | **Cutting-rule yellow.** |
| `--blade` | `#A5352A` | Destruction and failure only. 4.61:1 as the failed-save text. |
| `--ok` | `#3D6639` | Save confirmation only. 4.59:1 as the saved text. |

Surfaces are separated by tone and a soft shadow, not by a hairline on every edge. The previous
build outlined everything in `#B9B2A4` on beige, which is the single thing that made it read as
a decade old.

## Type

**Heebo** carries the Hebrew interface. One family for text, no display/body pairing.

**Archivo Narrow** on every figure that describes physical space: wall dimension strings, the
scale readout, the length input, page numbers, timestamps, the proposal count. These are set
`direction: ltr; unicode-bidi: isolate` inside the RTL page — a dimension string is not prose and
must not be reordered by the paragraph it sits in. This mirrors how dimensions are lettered on
real drawings and keeps long strings inside short walls.

`font-variant-numeric: tabular-nums` is on the `.num` class and every numeric input. Digits must
not shift width while a measurement updates.

Scale: 11px labels (0.04–0.06em tracking), 13px secondary, 14px base and controls, 15px lead
paragraph, 26px on the single h1 in the empty state.

## Layout

**Right to left by construction.** `dir="rtl"` on the root and logical properties throughout —
`inset-inline`, `border-inline-start`, `text-align: start`. Nothing is mirrored by hand, so the
plan sits on the right, the model beside it, and the instrument rail on the far left edge.

Three fixed rows: 56px topbar, flexible body, 30px status bar.

Body is a three-column grid: `minmax(0,1fr) / 400px / 60px`, and `minmax(0,1fr) / 62% / 60px`
when expanded. The plan is never smaller than the model; the sheet is the subject.

**The model pane is present from the first frame.** It used to collapse to zero width until a
model existed, which hid the one sentence explaining how to get one — the raise instrument was
disabled, the reason was invisible, and there was no sign a model pane existed at all. It now
carries a live count of what is still missing, a progress bar and its own raise button, and the
rail instrument marks itself the moment it becomes available.

Every column is `minmax(0, 1fr)`, not `1fr`. A plain `1fr` lets the topbar's non-shrinking chips
set a min-content floor on the whole app, which at 390px pushed the instrument rail off a screen
that cannot scroll.

Instruments live in a 60px rail at 42px targets, ordered by the actual sequence of work — select,
scale, wall, door, window, detect, then raise, dimensions, export, then undo and clear pinned to
the bottom. Disabled until their precondition is met, which is how the interface teaches the order.

Below 900px the model pane is removed rather than stacked. Tracing needs a pointer and a large
canvas; a phone gets the sheet and nothing else. The instruments that only act on the model —
raise and export — are removed with it, along with their shortcuts; the wordmark drops to its
glyph and the scale chip drops its label so the rail always fits.

## Components

Every control ships default, hover, active, disabled, and focus-visible. Focus is a 2px `--ink`
outline at 1px offset, on canvas handles as well as buttons.

- **Segmented controls** (Model/Render, Orbit/Eye level) use `aria-pressed`, not a class.
- **Popovers** are anchored to the rail and closed by outside click or Escape. No modals — nothing
  in this tool needs protected focus.
- **Empty states teach.** The plan pane opens with the four-step sequence and a real button. The
  model pane says what is missing and how many walls it needs.
- **Toast** for outcomes that leave the screen (a file saved). The status bar carries everything
  continuous, and clears the live measurement the moment nothing anchors it.
- **The model is framed, not guessed.** On the first raise the camera fits the eight corners of
  the plan's bounding box at the opening orbit angles, against the pane's own aspect. The stage is
  a tall narrow column, so it is the horizontal half-angle that sets the distance.
- **The proposal is reviewed on the sheet, never in a modal.** Detected walls are drawn as a
  pale band the thickness of the wall with a dashed graphite centreline — legible on black
  poché and on white paper alike — and a run switched off goes to a thin blade-red dash. A bar
  over the sheet carries the count and the three verbs. Yellow stays out of it: a proposal is
  not a selection, not a measurement, and not an instrument.
- **Three snap marks, one language.** A square on one of the user's own corners, a **diamond on a
  corner belonging to the drawing itself**, a cross on the 45° lock. All in `--rule`, because all
  three are the live measurement. Shift suppresses everything the software inferred and leaves the
  square, which is the only mark the user made.
- **Eye level stands, it does not orbit.** The camera is placed inside the largest room the user
  closed, set back a third of that room's longer axis and pointed down it, on a 70° interior lens.
  Orbit keeps the 48° lens. Orbiting a target two metres ahead only ever framed the wall behind it.

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
and the scale chip stays yellow and reads "not set" until then. The status bar says "Corners snap
to the drawing" only on a page that really has vector paths, and says nothing at all on a scan —
the interface never claims an accuracy it does not have.

## Known gaps

Recorded honestly so the next pass starts from truth.

**Finish review discharged.** Captured at 1440 and 390 against a real 1:50 vector plan, traced
end to end. 57 text elements measured on the render, including the save states a placeholder
config never reaches: 0 below AA, lowest 4.59:1. Open items below.

- **Eye level has no walk.** You can look around and pan, but not step through a doorway. The
  model has no ceiling either, so the sky is overhead from inside.
- Floors are correct only for closed traced loops; an open trace falls back to a bounding slab.
- Materials are procedural canvas textures, not a scanned PBR library.
- Single storey. No furniture. No AI rendering path yet.
