# pdf2model

Open an architectural PDF, trace it once, walk through it in 3D.

Everything runs in the browser: PDF rendering, tracing, geometry, and the 3D view. Firebase
stores the source PDF and the tracing so work survives a refresh. There is no server, no build
step, and no API key in the client.

---

## Get it live

You need the Firebase CLI once:

```bash
npm install -g firebase-tools
firebase login
```

### 1. Turn on three things in the Firebase console

Go to <https://console.firebase.google.com/project/pdf2model>.

| Where | What to do |
|---|---|
| **Build → Authentication** | Get started → Sign-in method → enable **Anonymous** |
| **Build → Firestore Database** | Create database → **production mode** → pick a region (`eur3` or `europe-west1`) |
| **Build → Storage** | Get started → same region |
| **Build → Hosting** | Get started (you can stop at step 1, the CLI does the rest) |

Region matters and cannot be changed later. Pick one close to your users and use the same one
for both Firestore and Storage.

### 2. Paste your web config

Console → **gear icon → Project settings → Your apps**. If there is no web app yet, click `</>`
and register one (skip the hosting step it offers).

Copy the `firebaseConfig` values into `public/firebase-config.js`.

These values are **not secrets**. They identify the project; they do not grant access. Access is
controlled entirely by `firestore.rules` and `storage.rules`, which are in this repo. Never put a
service-account key or a model API key in `public/`.

### 3. Deploy

```bash
firebase deploy
```

That publishes hosting, the Firestore rules and index, and the Storage rules together.

Your app is at **https://pdf2model.web.app**

To preview locally first:

```bash
firebase emulators:start   # or just open public/index.html
```

---

## How it works

```
PDF ──pdf.js──▶ page bitmap ──▶ you mark it ──▶ measured vector plan
                                                        │
                                        metres per pixel │ (from your calibration)
                                                        ▼
                              wall segments ──split around openings──▶ boxes
                                                        │
                                                        ▼
                                         three.js scene ──▶ orbit · eye level
                                                        │
                                                  ┌─────┴─────┐
                                                  ▼           ▼
                                              PNG image    OBJ model
```

The one thing the software refuses to guess is which lines are walls. A human answers that in
seconds; automatic detection on a scanned plan is a research problem. So the user points, and
everything downstream — geometry, openings, materials, lighting, export — is exact.

**Calibration is the gate.** Nothing renders a dimension before you have drawn one line of known
length. A tool that lies about size has no reason to exist.

## Using it

| Key | Action |
|---|---|
| `S` | Set scale |
| `W` | Trace wall |
| `D` / `N` | Door / window |
| `V` | Select |
| `R` | Raise the walls |
| `E` | Export |
| `Shift` | Break the 45° snap while drawing |
| `Space` + drag | Pan |
| `Esc` | End the current run |
| `⌘Z` / `Ctrl+Z` | Undo |
| `⌘S` / `Ctrl+S` | Save now |

Close the loop — click back on your first corner — and that run becomes a room with a real floor.
An open trace still stands up, but it gets a plain slab underneath.

## Data

```
projects/{id}          uid · name · pdfName · pageNum · mpp
                       dims · nodes · walls · rooms · openings · updatedAt
plans/{uid}/{id}.pdf   the source PDF, 25 MB cap
```

A project belongs to one anonymous user and is unreadable by anyone else. Clearing browser
storage loses the anonymous identity and therefore the plans — this is the honest limit of
frictionless sign-in, and the fix is to add Google sign-in when it starts to matter.

## Documents

- `PRODUCT.md` — who this is for and what is deliberately out of scope
- `DESIGN.md` — the visual system as built, including its known gaps

Design work in this repo follows the [Impeccable](https://impeccable.style) skill. Install it
with `npx impeccable install` from the repo root.

## Not done yet

- No finish review. This build has never been inspected in a browser at two widths.
- Single storey, no furniture.
- Render mode is real-time three.js with procedural materials — good, not photoreal. The
  photoreal path is a server-side render call fed by the depth buffer of this same geometry,
  and it needs a Cloud Function so the API key never reaches the browser.
- Vector PDFs are rasterised like any other. Reading their real line geometry would make snapping
  much better and is the highest-value next step.
