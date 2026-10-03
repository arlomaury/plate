// Vercel serverless function — POST /api/estimate
// Receives a resized food photo, asks Claude for an itemized nutrition
// estimate, and returns clean JSON. Your ANTHROPIC_API_KEY never leaves
// the server. Set these in Vercel > Settings > Environment Variables:
//   ANTHROPIC_API_KEY   (required)
//   SUPABASE_URL        (required - every request must be a signed-in user)
//   SUPABASE_ANON_KEY   (required - same)
//   ALLOWED_EMAILS      (recommended - comma-separated; only these accounts
//                        may run estimates and spend your API credits)
//   ALLOWED_ORIGIN      (optional - e.g. https://plate-xyz.vercel.app; only
//                        needed if the app is served from another domain)
//   ESTIMATE_MODEL      (optional, default claude-sonnet-4-6)

const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_B64 = 4 * 1024 * 1024;   // ~3MB image; the app sends ~100KB
const MAX_TEXT = 1000;                    // characters of meal description

// Per-user rate limit.  Serverless instances don't share memory, so this is a
// brake on runaway loops and abuse from one account rather than a hard quota;
// ALLOWED_EMAILS plus disabled sign-ups is the real fence.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.ESTIMATES_PER_10_MIN) || 30;
const recent = new Map();                 // user id -> [timestamps]
function rateLimited(userId, now = Date.now()) {
  const list = (recent.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) { recent.set(userId, list); return true; }
  list.push(now);
  recent.set(userId, list);
  if (recent.size > 5000) recent.clear(); // bound memory on a long-lived instance
  return false;
}

const PROMPT = `You are a careful nutrition estimator. You may be given a food photo, a written description of a meal, or both. Break the meal into its components and estimate calories and macros for each.
Respond with ONLY a raw JSON object (no markdown, no backticks, no extra text) with exactly these keys:
{
  "name": "short overall dish name",
  "description": "1-2 sentences on what you based the estimate on and the portion you assumed",
  "items": [
    {"name": "component name", "calories": integer, "protein_g": integer, "carbs_g": integer, "fat_g": integer}
  ],
  "confidence": "low" | "medium" | "high"
}
Each entry in "items" is one part of the meal (e.g. the chicken, the rice, the dressing) with its own calories and macros for the portion shown or described. Include every component you can identify. When both a photo and a description are given, treat the description as the person's correction or clarification and prefer it where they conflict. If you have neither a clear photo nor a usable description, return an empty "items" array and explain in "description".`;

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_ANON_KEY;
    if (!apiKey || !sbUrl || !sbKey) {
      // Fail closed: without the Supabase settings the function could not
      // tell who is calling, and anyone with the URL could spend your credits.
      return res.status(500).json({ error: "Server is not configured" });
    }

    // Every request must come from a signed-in user.
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const u = await fetch(sbUrl + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: sbKey },
    });
    if (!u.ok) return res.status(401).json({ error: "Invalid session" });
    const user = await u.json().catch(() => ({}));

    // Optional allowlist: signing up is open by default in Supabase, so this
    // is what stops a stranger who finds your URL from creating an account
    // and running estimates on your API key.
    const allowed = (process.env.ALLOWED_EMAILS || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(String(user.email || "").toLowerCase())) {
      return res.status(403).json({ error: "This account is not allowed to run estimates" });
    }
    if (rateLimited(String(user.id || user.email || token.slice(-16)))) {
      return res.status(429).json({ error: "Too many estimates - wait a few minutes and try again" });
    }

    let body;
    try { body = await readJson(req); }
    catch { return res.status(400).json({ error: "Request body must be JSON" }); }
    body = body && typeof body === "object" ? body : {};
    const image = typeof body.image === "string" ? body.image : "";
    const mediaType = body.mediaType || "image/jpeg";
    const noteText = typeof body.text === "string" ? body.text.trim() : "";
    if (!image && !noteText) return res.status(400).json({ error: "Provide a photo or a description" });
    if (image && !ALLOWED_MEDIA.has(mediaType)) return res.status(400).json({ error: "Unsupported image type" });
    if (image.length > MAX_IMAGE_B64) return res.status(413).json({ error: "Photo is too large" });
    if (noteText.length > MAX_TEXT) return res.status(400).json({ error: "Description is too long (max " + MAX_TEXT + " characters)" });

    const content = [];
    if (image) content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: image } });
    const userText = noteText
      ? PROMPT + "\n\nThe person describes the meal as: \"" + noteText + "\"" + (image ? " Use both the photo and this description." : "")
      : PROMPT;
    content.push({ type: "text", text: userText });

    const model = process.env.ESTIMATE_MODEL || "claude-sonnet-4-6";
    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content }],
      }),
    });

    if (!ar.ok) {
      // Log the upstream detail server-side (Vercel > Logs); don't hand it to
      // the browser, where it could reveal account or billing state.
      console.error("Anthropic error", ar.status, (await ar.text().catch(() => "")).slice(0, 500));
      const msg = ar.status === 429 ? "Too many estimates right now - try again in a minute"
        : ar.status === 404 ? "The AI model '" + model + "' is not available - set ESTIMATE_MODEL in Vercel to a current Claude model"
        : ar.status === 401 ? "The server's Anthropic API key was rejected - check ANTHROPIC_API_KEY in Vercel"
        : "The estimate service is unavailable (" + ar.status + ")";
      return res.status(502).json({ error: msg });
    }

    const data = await ar.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    let clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    let obj;
    try { obj = JSON.parse(clean); }
    catch {
      const m = clean.match(/\{[\s\S]*\}/);
      if (!m) return res.status(502).json({ error: "Could not parse estimate" });
      try { obj = JSON.parse(m[0]); }
      catch { return res.status(502).json({ error: "Could not parse estimate" }); }
    }

    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return res.status(502).json({ error: "Could not parse estimate" });
    }
    // Clamp everything the model says to what a meal can plausibly be (and to
    // the database's own limits), so a garbled reply can't produce a meal
    // that then fails to save.
    const n = (v, hi) => Math.min(hi, Math.max(0, Math.round(Number(v) || 0)));
    const items = Array.isArray(obj.items) ? obj.items
      .filter((it) => it && typeof it === "object")
      .slice(0, 20)
      .map((it) => ({
        name: String(it.name || "Item").slice(0, 120),
        calories: n(it.calories, 5000),
        protein_g: n(it.protein_g, 500),
        carbs_g: n(it.carbs_g, 500),
        fat_g: n(it.fat_g, 500),
      })) : [];

    const sum = items.reduce((a, it) => ({
      calories: a.calories + it.calories, protein: a.protein + it.protein_g,
      carbs: a.carbs + it.carbs_g, fat: a.fat + it.fat_g,
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    return res.status(200).json({
      name: String(obj.name || "Meal").slice(0, 120),
      description: String(obj.description || "").slice(0, 600),
      items,
      calories: sum.calories, protein_g: sum.protein, carbs_g: sum.carbs, fat_g: sum.fat,
      confidence: ["low", "medium", "high"].includes(obj.confidence) ? obj.confidence : "medium",
    });
  } catch (e) {
    console.error("estimate failed", e);
    return res.status(500).json({ error: "Server error" });
  }
};

// The app calls this function from its own domain, which needs no CORS at
// all. Only echo an origin back if you explicitly allow one (ALLOWED_ORIGIN),
// so other websites can't call your endpoint from a visitor's browser.
function setCors(req, res) {
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.origin === allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  res.setHeader("Cache-Control", "no-store");
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body) { // Vercel often parses JSON already
      try { return resolve(typeof req.body === "string" ? JSON.parse(req.body) : req.body); }
      catch (e) { return reject(e); }
    }
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

module.exports._rateLimited = rateLimited;   // exposed for tests
