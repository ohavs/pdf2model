# pdf2model — working context

Read this before touching anything. It carries the decisions that are already made, so you
extend the project instead of restarting it.

## What this is

A browser tool that turns an architectural PDF into a measured 3D interior. The user opens a
plan, calibrates it against one known length, traces the walls by clicking corners, cuts doors
and windows into them, and the walls rise into a model they can orbit or stand inside.

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
measurement, and the unset-scale chip — four uses, never decorative, never as a text color.
Archivo throughout, Archivo Narrow on every dimension string, tabular figures everywhere a
number describes space. Operate mode: familiar affordances, restrained color, no modals.

Explicitly refused and not to be reintroduced: blueprint cyan-on-navy, cream-plus-serif
editorial, dark-mode-plus-neon, feature-card grids, gradient text, emoji as icons.

Design work here follows the Impeccable skill. Install it once with `npx impeccable install`
from the repo root, then load it before UI changes. Note that `concept-seed.mjs` needs network
access to `impeccable.style`; the original direction roll ran degraded without it.

## Hard rules

- **No secret ever reaches `public/`.** The Firebase web config there is not a secret — it
  identifies the project and grants nothing. Model API keys, service accounts and anything
  signed go in a Cloud Function, never the client.
- **Calibration is a gate.** No dimension is displayed, and no wall can be traced, before the
  user has set scale. Never estimate or infer a scale silently.
- **Metric first.** Imperial is an equal option to add, never the default.
- **Never invent geometry the user did not mark.** No auto-detected walls presented as fact.
- Layout is RTL-ready by construction; keep it that way rather than retrofitting.

## State of the work

Built and working: PDF load with multi-page, pan and zoom, calibration, wall tracing with
endpoint and 45° snapping, live dimension strings, doors and windows cut as real geometry,
closed loops becoming floors, the rise animation, Model and Render material modes, orbit and
eye-level cameras, undo, autosave to Firestore, PDF to Storage, recent-plans list, and PNG,
OBJ and JSON export.

**Not verified:** this build has never been opened in a browser. Nothing has been screenshotted,
no contrast measured on a render, no responsive behaviour confirmed. Treat every visual claim in
`DESIGN.md` as intention until you have checked it.

## Task queue, in order

1. **Discharge the finish review.** This is an outstanding contract item, not optional. Serve
   the site, load a real PDF, capture desktop (1440) and mobile (390) in one batched round, run
   the Impeccable finish reviewer against the direction contract, fix findings in one batch,
   recapture, get a verdict. Report the verdict table as written, open items included.
2. **Deploy and confirm.** `firebase deploy`, then load `https://pdf2model.web.app` and verify
   anonymous auth, save, reload, and reopen from the recent list actually work end to end.
3. **Read vector PDFs properly.** Right now every PDF is rasterised. When the page has real
   vector paths, extract them with pdf.js `getOperatorList` and snap tracing to actual line
   endpoints instead of guessed pixels. Highest-value accuracy work available.
4. **Photoreal render path.** A Cloud Function that takes the depth and normal buffers from the
   existing three.js camera plus a style prompt and returns an image. The geometry is already
   exact, which is the whole advantage — the model only paints it. Key stays server-side.
5. **Interior content.** Curated PBR materials and a small furniture library in GLB. This is the
   product's stated centre of gravity and currently its thinnest part.

Out of scope until asked: multi-storey, exteriors and roofs, DWG import, construction documents.

## Working style

Small commits with real messages. Do not add a build step, a framework, or a dependency without
saying why first. If a change would contradict `DESIGN.md`, update `DESIGN.md` in the same
commit and say what changed.
