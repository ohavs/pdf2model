# pdf2model — working context

Read this before touching anything. It carries the decisions that are already made, so you
extend the project instead of restarting it.

## What this is

A browser tool that turns an architectural PDF into a measured 3D interior. **Importing a
vector plan is enough**: the software reads the scale off the drawing, detects the walls from
its geometry, and the model stands — typically inside four seconds. Everything it worked out is
stated on screen and replaceable, and everything is editable afterwards by hand: drag a wall,
cut a door or a window, re-calibrate, retrace. On a scan, or a page it cannot read, it asks for
one known length and the old manual flow takes over unchanged.

Audience now: curious non-professionals holding a real plan from their architect. Audience next,
gated on quality: architects and interior designers producing a fast client-facing visual.
`PRODUCT.md` holds the full product truth including what is deliberately out of scope.

## Stack

Static site, no build step. `public/index.html` + `public/app.js`, vanilla JS.
pdf.js and three.js r128 from CDN. Firebase for anonymous auth, Firestore, Storage, Hosting.
Deploy is `firebase deploy` from the repo root. Project id `pdf2model`.

## Design — do not redesign

The visual world is committed and documented in `DESIGN.md`, written from the built code.
The direction contract is an HTML comment at the top of `<body>` in `index.html`. Read both
before any UI edit.

Short version: architectural model shop. Chipboard mat, museum-board panels, graphite ink,
one cutting-rule yellow (`--rule`) reserved for the active instrument, current selection, live
measurement, and the unset-scale chip — four uses, never decorative, never as a text color on
board. Heebo for Hebrew text, Archivo Narrow on every dimension figure, tabular figures
everywhere a number describes space. Operate mode: familiar affordances, restrained color,
no modals — including the detection proposal, which is reviewed on the sheet itself.

The control surface was rebuilt once, on the owner's call, because it read a decade old:
36–42px targets, 8px radii, layered warm panels with soft shadows instead of hairline borders
on beige. The material world did not change. Do not restart it again without the same kind of
explicit instruction.

Explicitly refused and not to be reintroduced: blueprint cyan-on-navy, cream-plus-serif
editorial, dark-mode-plus-neon, feature-card grids, gradient text, emoji as icons.

Design work here follows the Impeccable skill. Install it once with `npx impeccable install`
from the repo root, then load it before UI changes. Note that `concept-seed.mjs` needs network
access to `impeccable.style`; the original direction roll ran degraded without it.

## Hard rules

- **No secret ever reaches `public/`.** The Firebase web config there is not a secret — it
  identifies the project and grants nothing. Model API keys, service accounts and anything
  signed go in a Cloud Function, never the client.
- **Scale is read, never guessed, and never silent.** A plan states its own scale, so the
  software reads it — the printed ratio (`1:100`, `קנ״מ 1:50`) against the page's physical size,
  cross-checked against the lettered dimension strings matched to the lines they annotate. What
  was read and how it was read is on screen, and one click replaces it with a hand calibration.
  When the drawing cannot be read — a scan, no ratio, too few dimensions — it says so and asks.
  It must never invent a scale, and never adopt one without showing its source.
- **Metric first.** Metres or centimetres, chosen in the calibration popover and remembered.
  Imperial is an equal option to add, never the default.
- **Never present geometry as fact that the user did not accept.** Detection may *propose* —
  drawn as a reviewable overlay, every run toggleable, nothing entering the model until the
  user accepts it. It may never assert. This replaces the earlier blanket ban on detection;
  the ban was on fake certainty, and a proposal the user confirms carries none.
- **Hebrew, RTL.** The interface is Hebrew and lays out right to left. Figures that describe
  space stay LTR-isolated in Archivo Narrow — a dimension string is not prose.

## State of the work

Built and working: PDF load with multi-page, pan and zoom, calibration in metres or centimetres,
**wall detection proposed from the drawing's own vector geometry and confirmed by the user**,
manual wall tracing with endpoint, drawing-corner and 45° snapping, live dimension strings,
doors and windows cut as real geometry, closed loops becoming floors, the rise animation, Model
and Render material modes, orbit and eye-level cameras, undo, autosave to Firestore, PDF to
Storage, recent-plans list, and PNG, OBJ and JSON export. Hebrew and RTL throughout. Marks are
bounded by the sheet, and an edit on the paper reaches the model immediately.

**Verified in a browser.** Driven end to end at 1440 and 390 against a real 1:50 vector plan:
load, calibrate, trace, cut openings, raise, Model and Render, orbit and eye level, expand,
both popovers, export menu. 54 text elements measured on the render, none below AA, lowest
4.56:1. `DESIGN.md` now records what the code does, not what was intended.

**The cloud path is verified against the live project**: anonymous auth, autosave to Firestore,
PDF to Storage, reload, the recent-plans list, reopen, and delete. Deployed at
`https://pdf2model.web.app`. With no config or a dead backend the app still works and says so —
"Local only" or "Offline", and the empty state switches to "nothing leaves your browser".

**Not verified:** the detector against a real 1:100 plan. See queue item 4.

The harnesses are not in the repo; they live in the session scratchpad. To rebuild: serve
`public/`, drive it with Playwright, and substitute the blocked CDN scripts with copies vendored
from npm. `contrast.js` walks every visible text node and measures it against AA; `drive.js`
captures the full flow at 1440 and 390; `dettest.js` exercises detection; `cloudtest.js` does the
live backend round trip.

## Task queue, in order

1. ~~**Discharge the finish review.**~~ Done. Captured at 1440 and 390 against a real vector
   plan, findings fixed in one batch, recaptured, `DESIGN.md` rewritten from the render. The
   Impeccable finish reviewer could **not** be run: `npx impeccable install` reaches
   `impeccable.style`, which this environment's egress policy returns 403 for. The review was
   conducted by hand against the direction contract in `index.html` and `DESIGN.md`. Re-run it
   with the real reviewer when the host is reachable.
2. ~~**Deploy and confirm.**~~ Done and verified against the live project. `firebase deploy`
   ships hosting, rules and indexes; the site is `https://pdf2model.web.app`. Auth (anonymous),
   Firestore and Storage are all provisioned and the rules are released.

   Verified end to end from localhost against the real backend — a deploy is not needed for
   this, the SDK talks to the live project either way: anonymous auth → open a plan → detection
   accepted → autosave to Firestore → PDF to Storage → reload in a fresh page → same anonymous
   uid → plan in the recent list → reopen with all 21 walls, the scale and the PDF restored →
   delete both the doc and the file. All five steps pass, nothing left behind.

   Two rules bugs this turned up, both fixed and released:
   - **Storage delete was impossible for the owner.** `allow write` required
     `request.resource.size` and `contentType`, but a delete carries no `request.resource`, so
     every upload was permanent. `read, delete` is now its own rule. Confirmed by a live
     `storage/unauthorized` on the owner's own file before the fix, and a clean delete after.
   - **Firestore update only checked `resource.data.uid`,** so an owner could rewrite the `uid`
     field and hand their document to someone else. It now checks `request.resource.data.uid`
     as well.

   Two notes for the next session. `www.gstatic.com`, `pdf2model.web.app` and
   `pdf2model.firebaseapp.com` are all blocked by this sandbox's egress policy, so the live URL
   cannot be loaded here — verify by hash against the Hosting API instead, and vendor the
   `firebase-*-compat.js` bundles from npm to test locally. And Chromium's own TLS through the
   sandbox relay resets on the googleapis hosts; route those requests through Playwright's
   `route.fetch()` so Node does the fetching. `cloudtest.js` in the session scratchpad does all
   of this and is worth rebuilding.

3. ~~**Read vector PDFs properly.**~~ Done. `readVectors()` in `app.js` walks
   `getOperatorList`, carries the CTM through save/restore/transform and form XObjects, and
   feeds the endpoints to `snapPoint`. Verified: clicks 100 mm off every corner of an 11×8 m
   envelope trace 11, 8, 11, 8 exactly; Shift suppresses it; a scanned page extracts nothing
   and behaves as before. **Endpoints only** — segments are discarded after their endpoints are
   taken, so there is no snap to a point *along* a wall, and no perpendicular or midpoint snap.
   That is the obvious next increment.
4. **Tune the detector on real plans.** *(Partly addressed: the thickness the detector measures
   off the drawing's poché is now carried into the model instead of being discarded, so an
   envelope and a partition no longer come out identical — 18 walls spanning 0.10 m to 0.25 m on
   the test sheet. The ranking work below is still open.)* `detectWalls()` finds the envelope and every partition
   on a 1:50 test sheet — 21 runs from 188 segments — but it also proposes fixtures and joinery
   as short runs, and it has never been measured against a 1:100 sheet with thinner walls or
   against Israeli drafting conventions. The review step absorbs the noise, but the ranking is
   the thing to improve: prefer long, well-supported runs, and consider dropping candidates that
   sit inside a room rather than on its boundary. Needs real plans to tune against, not
   synthetic ones.
5. ~~**Photoreal render path.**~~ Removed, on the owner's instruction. Every hosted image model
   is billed per call and the owner's constraint is absolute: not one cent. The Cloud Function,
   its API key, its secret and the whole `functions/` directory were deleted. Do not rebuild
   this without an explicit new instruction.

6. **Interior content — blocked on network policy, not on code.** Every source of free
   production-grade assets is unreachable from this sandbox's egress policy:

   | host | what it has | status |
   |---|---|---|
   | `ambientcg.com` | CC0 PBR materials — flooring, plaster, tile | **blocked** |
   | `cdn.polyhaven.com`, `api.polyhaven.com` | CC0 HDRIs, textures, models | **blocked** |
   | `kenney.nl` | CC0 low-poly furniture, ~100 KB a piece — the right size for this | **blocked** |
   | `cdn.jsdelivr.net`, `unpkg.com` | npm/GitHub CDN mirrors | **blocked** |
   | `raw.githubusercontent.com` | reachable, `access-control-allow-origin: *` | reachable |
   | `registry.npmjs.org` | reachable | reachable |

   The one reachable model source is `KhronosGroup/glTF-Sample-Assets`, and it is a **glTF
   conformance test suite, not a furniture library**. Of 148 models the usable interior pieces
   are two — `GlamVelvetSofa` (3.1 MB, CC-BY-4.0) and `SheenChair` (4.1 MB, CC0) — and both
   lean on `KHR_materials_sheen` and `KHR_materials_variants`, which the r128 GLTFLoader does
   not fully support, so they would render without the material they exist to demonstrate.
   7 MB for two pieces that come out wrong is not interior content; it was not shipped.

   Note the size question is **not** a hosting-cost question. Assets fetched by the visitor's
   browser from a third-party CDN never touch Firebase Hosting's quota. The objection is the
   visitor's bandwidth and the wrong-tool-for-the-job shape of these particular files.

   To unblock, either:
   - allow `ambientcg.com`, `kenney.nl` and `polyhaven.com` (plus `cdn.polyhaven.com`) in the
     environment's network policy, and the assets can be vendored and wired; or
   - drop the asset files into `public/assets/` by hand and the same work proceeds offline.

   When it is unblocked: `furnishRoom()` in `app.js` already computes a position, footprint and
   rotation for every piece it places. Tag those meshes with a slot descriptor, load the GLB
   lazily, fit it to the slot's bounding box and swap — the procedural furniture stays as the
   instant first frame and as the fallback, so nothing blocks on a download.

7. **The editor.** Six phases, all but the assets one done and live.
   1. ~~Identity, named history, incremental rebuild.~~
   2. ~~Selection as a set; handles; marquee; nudging.~~
   3. ~~The snap engine: nine magnets, guides, Alt/Shift suppression, a settings popover.~~
   4. ~~The properties panel: every number editable, type-while-dragging, off-sheet refused.~~
   5. Assets — see item 6.
   6. ~~Operations: duplicate, offset, series, split, weld, straighten, mirror, align,
      distribute, axis lock.~~

   Harnesses in the session scratchpad, all passing: `seltest.js` (27), `snaptest.js` (17),
   `proptest.js` (29), `opstest.js` (35), plus `histtest.js`, `layouttest.js`, `autotest.js`
   and `contrast.js` (148 text elements, 0 below AA).

Out of scope until asked: multi-storey, exteriors and roofs, DWG import, construction documents.

## Working style

Small commits with real messages. Do not add a build step, a framework, or a dependency without
saying why first. If a change would contradict `DESIGN.md`, update `DESIGN.md` in the same
commit and say what changed.
