/* pdf2model — the photoreal render path.

   The geometry is already exact, which is the whole advantage: the model is not
   asked to invent a room, only to paint the one we measured. So the request is
   image-to-image on the three.js frame, with a prompt that says in as many words
   that the layout, the openings and the camera are fixed.

   The API key lives here and only here. The browser never sees it — it calls
   this function with its Firebase auth token and gets an image back. */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

/* A render costs real money on the owner's account, and anonymous auth means
   anyone can get a uid. So: a hard daily ceiling per user, counted server side
   where the client cannot reach it. */
const DAILY_LIMIT = 30;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/* Tried in order. Google retires image models faster than this app will be
   redeployed — gemini-2.5-flash-image is already closed to new projects — so
   the current generation leads and the older names stay as fallbacks. */
const MODELS = (process.env.RENDER_MODEL || "").split(",").filter(Boolean).length
  ? process.env.RENDER_MODEL.split(",").map(s => s.trim())
  : ["gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-2.5-flash-image"];
const ENDPOINT = m =>
  `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

/* The style the user picked is the only thing they steer. Everything else is
   fixed instruction, because a model told "make it nice" will happily move a
   wall and hand back a room that was never measured. */
const STYLES = {
  day:      "bright natural daylight from the windows, clear midday sun, crisp shadows",
  evening:  "warm low evening light, lamps on inside, dusk sky outside the windows",
  overcast: "soft even overcast daylight, no hard shadows, calm and neutral",
  warm:     "warm scandinavian interior, oak floors, linen and wool, soft morning light",
  minimal:  "quiet minimal interior, pale plaster, few objects, restrained palette",
};

function buildPrompt(style, note) {
  const look = STYLES[style] || STYLES.day;
  return [
    "This is a rendering of an architectural model built from a measured floor plan.",
    "Repaint it as a photorealistic architectural visualisation.",
    "",
    "Hold these exactly as they are — they are measured, not invented:",
    "- the position, length and thickness of every wall",
    "- the position and size of every door and window opening",
    "- the camera angle, framing and perspective",
    "- the overall proportions of every room",
    "",
    "Do not add, remove or move any wall, door or window. Do not change the viewpoint.",
    "Do not add rooms, floors or storeys that are not in the image.",
    "",
    "What to improve: surface realism, materials, lighting, and the quality of the light.",
    `Look and mood: ${look}.`,
    note ? `The person asked for: ${String(note).slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");
}

const dataUrlToInline = url => {
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(url || "");
  if (!m) throw new HttpsError("invalid-argument", "Expected a base64 data URL.");
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) throw new HttpsError("invalid-argument", "That frame is too large to send.");
  return { mime_type: m[1], data: m[2] };
};

async function takeQuota(uid) {
  const today = new Date().toISOString().slice(0, 10);
  const ref = db.collection("renderQuota").doc(uid);
  return db.runTransaction(async t => {
    const snap = await t.get(ref);
    const d = snap.exists ? snap.data() : {};
    const used = d.day === today ? (d.used || 0) : 0;
    if (used >= DAILY_LIMIT) return { ok: false, used, limit: DAILY_LIMIT };
    t.set(ref, { day: today, used: used + 1, at: Date.now() }, { merge: true });
    return { ok: true, used: used + 1, limit: DAILY_LIMIT };
  });
}

async function callOne(model, key, prompt, beauty) {
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: dataUrlToInline(beauty) }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], temperature: 0.6 },
  };
  const res = await fetch(ENDPOINT(model), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message || msg; } catch (_) {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error("unreadable response"); }
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData || p.inline_data);
  const inline = img && (img.inlineData || img.inline_data);
  if (!inline?.data) {
    const said = parts.map(p => p.text).filter(Boolean).join(" ").slice(0, 200);
    throw new Error(said ? `no image; the service said: ${said}` : "no image came back");
  }
  return `data:${inline.mimeType || inline.mime_type || "image/png"};base64,${inline.data}`;
}

async function callGemini(key, prompt, beauty) {
  let last = null;
  for (const m of MODELS) {
    try { return await callOne(m, key, prompt, beauty); }
    catch (e) {
      last = e;
      /* 404 means that name is gone for this project; try the next. Anything
         else — quota, billing, a refusal — is the real answer and stops here. */
      if (e.status !== 404) break;
    }
  }
  const msg = String(last && last.message || "");
  if (/prepayment|credits|billing|quota/i.test(msg)) {
    const err = new HttpsError("resource-exhausted",
      "לחשבון ה־Gemini אין קרדיט. הוסיפו אמצעי תשלום ב־ai.studio/projects ונסו שוב.");
    err.detail = msg; throw err;
  }
  throw new HttpsError("internal", `הרנדור נכשל: ${msg.slice(0, 200)}`);
}

exports.renderView = onCall(
  { secrets: [GEMINI_API_KEY], timeoutSeconds: 120, memory: "512MiB", region: "us-central1", cors: true },
  async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const uid = request.auth.uid;
    const { beauty, style, note } = request.data || {};
    if (!beauty) throw new HttpsError("invalid-argument", "No view was sent to render.");

    const key = GEMINI_API_KEY.value();
    /* With no key configured the whole path still runs and says so, rather than
       failing in a way that looks like a bug in the app. A real key is ~39
       characters; the placeholder the function ships with is not. */
    if (!key || key === "UNSET" || key.length < 20) {
      return { ok: false, reason: "no-key",
        message: "מפתח הרנדור עדיין לא הוגדר בשרת. כל השאר מוכן." };
    }

    const quota = await takeQuota(uid);
    if (!quota.ok) {
      return { ok: false, reason: "quota",
        message: `הגעתם למכסת ${quota.limit} הרנדורים להיום.` };
    }

    const image = await callGemini(key, buildPrompt(style, note), beauty);
    return { ok: true, image, used: quota.used, limit: quota.limit };
  }
);
