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
OBJ and JSON export. On a vector page, tracing snaps to the drawing's own corners.

**Verified in a browser.** Driven end to end at 1440 and 390 against a real 1:50 vector plan:
load, calibrate, trace, cut openings, raise, Model and Render, orbit and eye level, expand,
both popovers, export menu. 54 text elements measured on the render, none below AA, lowest
4.56:1. `DESIGN.md` now records what the code does, not what was intended.

**Still unverified:** anything that needs the live Firebase project — anonymous auth, save,
reload, and the recent-plans list have never run against a real backend, because
`public/firebase-config.js` still holds `PASTE_…` placeholders and there are no deploy
credentials in this environment. The app is designed to run without it and reports "Local only".

The finish-review harness is not in the repo; it lives in the session scratchpad. To rebuild it:
serve `public/`, drive it with Playwright, and substitute the CDN scripts with local copies if
your network blocks cdnjs. Firebase's own CDN can be stubbed — `Cloud.init` bails on a
placeholder config anyway.

## Task queue, in order

1. ~~**Discharge the finish review.**~~ Done. Captured at 1440 and 390 against a real vector
   plan, findings fixed in one batch, recaptured, `DESIGN.md` rewritten from the render. The
   Impeccable finish reviewer could **not** be run: `npx impeccable install` reaches
   `impeccable.style`, which this environment's egress policy returns 403 for. The review was
   conducted by hand against the direction contract in `index.html` and `DESIGN.md`. Re-run it
   with the real reviewer when the host is reachable.
2. **Deploy and confirm — BLOCKED, needs you.** The real web config is now in
   `public/firebase-config.js` and the key is valid. **The project's backend services have
   never been provisioned.** Probed directly against the Google APIs:
   - Auth → `CONFIGURATION_NOT_FOUND`. Console → Authentication → Get started → enable the
     **Anonymous** provider.
   - Firestore → `PERMISSION_DENIED: Cloud Firestore API has not been used in project pdf2model
     before or it is disabled`. Console → Firestore Database → Create database.
   - Storage → bucket 404 under both `pdf2model.firebasestorage.app` and `pdf2model.appspot.com`.
     Console → Storage → Get started. (The console prints a `storageBucket` string before the
     bucket exists, so the config value is not evidence that it does.)

   Then deploy credentials, which only the owner can mint: `FIREBASE_TOKEN`, or a service-account
   JSON at `GOOGLE_APPLICATION_CREDENTIALS`. `firebase login` cannot run here — no browser.
   `firebase-tools` installs fine and the rules and indexes read correctly.

   Note that most of the *verification* does not need a deploy: serve `public/` on localhost and
   the SDK talks to the real project. `identitytoolkit`, `firestore` and `firebasestorage`
   googleapis hosts are reachable from this sandbox; `www.gstatic.com` and
   `pdf2model.firebaseapp.com` are not, so vendor the `firebase-*-compat.js` bundles from npm.
   `cloudtest.js` in the session scratchpad does auth → save → reload → recent list → reopen →
   cleanup and is worth rebuilding.

   Verified meanwhile: with a real config whose backend is dead, the app degrades honestly —
   "Offline", a toast saying nothing will be saved, and the empty state switched to "Nothing
   leaves your browser."

   One thing to tighten while you are in there: `firestore.rules` checks `resource.data.uid` on
   update but not `request.resource.data.uid`, so an owner can rewrite the `uid` field on their
   own doc. Untested here, so left alone.
3. ~~**Read vector PDFs properly.**~~ Done. `readVectors()` in `app.js` walks
   `getOperatorList`, carries the CTM through save/restore/transform and form XObjects, and
   feeds the endpoints to `snapPoint`. Verified: clicks 100 mm off every corner of an 11×8 m
   envelope trace 11, 8, 11, 8 exactly; Shift suppresses it; a scanned page extracts nothing
   and behaves as before. **Endpoints only** — segments are discarded after their endpoints are
   taken, so there is no snap to a point *along* a wall, and no perpendicular or midpoint snap.
   That is the obvious next increment.
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
