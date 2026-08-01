# Product

## Register

product

## Users

**Now:** curious non-professionals who have a real architectural PDF in hand — an apartment they are buying, renovating, or renting. Their architect, contractor, or agent sent them a plan they cannot read. They are not designers and will not learn CAD. They open the file, poke at it, and want to see the space.

**Next (gated on quality):** architects, interior designers, and drafters who want a fast client-facing visual from a plan they already drew. They are fluent in the drawing conventions and will judge the output on whether the proportions are right.

The first audience forgives a rough edge. The second does not, and is the reason the geometry must be measured rather than approximated from the start.

## Product Purpose

Turn a flat architectural PDF into a measured, inhabitable interior — a 3D space you can look around, and images good enough to show someone.

The mechanism the product owns: **the person confirms what things are.** The user marks one known length to set scale — the one thing a human answers instantly and a machine answers unreliably. From there the software reads the drawing's own vector geometry and *proposes* the walls: pairs of parallel faces a plausible thickness apart, nothing learned and nothing guessed about what a symbol means. The proposal is drawn on the sheet, every run can be switched off, and not one line becomes geometry until the user accepts it. Then they edit it by hand — click, drag, snap, undo — and a change on the paper is a change to the model immediately.

The distinction that matters: the software may propose, it may never assert. Auto-detection presented as fact would be exactly the fake certainty this product refuses.

Success: a first-time visitor with a real PDF reaches a 3D room in under three minutes without reading instructions, and the result is proportioned correctly enough that an architect would not object.

## Scope

**In:** vector and raster PDF input. Manual scale calibration. Wall detection from a vector page, proposed and confirmed. Wall, door, and window marking with snapping. Interior geometry. Materials, lighting, rendering. Single level.

**Out for now:** DWG/DXF. Recognition on a *scanned* page — with no vector geometry there is nothing to read, and guessing from pixels is the research problem this product declines. Exteriors, roofs, multi-story. Construction documentation. This is a visualization tool, not a drawing tool and not a CAD replacement.

## Brand Personality

Precise, physical, unhurried. The product behaves like a well-made instrument: it does one thing exactly, it tells you the truth about measurements, and it never pretends to know something it does not.

Three-word personality: **measured, tactile, plainspoken**.

## Anti-references

- **Blueprint costume.** Cyan hairlines on navy, drafting grids as wallpaper, sepia parchment. The most obvious artifact in this category and therefore the first thing to refuse.
- **Warm editorial architecture.** Cream ground, high-contrast serif display, terracotta accent. The predictable opposite of the blueprint, and equally a default.
- **Dark technical tool.** Near-black with a neon accent and glowing edges.
- **Generic AI-tool marketing:** purple gradients, glassmorphism, particle fields, feature-card grids.
- **A landing page carrying the product.** There is no marketing homepage in this build. The workbench is the front door.
- **Fake certainty.** Never display a dimension the user has not calibrated, never round silently, never render a wall the user did not mark.

## Design Principles

1. **The measurement is sacred.** Scale is established before anything else and is visible at all times. A tool that lies about size has no reason to exist.
2. **The sheet stays present.** The user's own PDF is the ground truth on screen, not a step that disappears once parsed. Everything the software infers sits visibly on top of it.
3. **Marking must feel like handling, not like data entry.** Click, drag, snap, undo. No forms where a gesture belongs.
4. **The tool disappears into the task.** Familiar affordances, consistent components, standard shortcuts. Expression lives in material and precision, never in reinvented controls.
5. **Show the space, not the software.** The 3D and the render are the product. Chrome gets the smallest budget on screen.

## Accessibility & Inclusion

Baseline WCAG 2.1 AA.

- Every marking action reachable by keyboard; the canvas is not a mouse-only surface.
- Visible focus states on all controls, including canvas handles.
- `prefers-reduced-motion` honored — the fold-up animation degrades to a cut.
- Metric first, imperial as an equal option, chosen once and remembered.
- Interface language: Hebrew, laid out right to left by construction. Figures stay LTR-isolated.

## Technical Constraints

- Web, desktop-first. The marking task needs a pointer and a large canvas; phone is view-and-share, not author.
- PDF rendering and 3D both run client-side.
- Rendering that requires a model API runs server-side only. No API key ever reaches the browser.
- Storage and auth: Firebase.
