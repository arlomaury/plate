// Vercel serverless function — POST /api/estimate
// Receives a resized food photo, asks Claude for an itemized nutrition
// estimate, and returns clean JSON. Your ANTHROPIC_API_KEY never leaves
// the server. Set these in Vercel > Settings > Environment Variables:
//   ANTHROPIC_API_KEY   (required)
//   SUPABASE_URL        (optional, enables auth check)
//   SUPABASE_ANON_KEY   (optional, enables auth check)
//   ESTIMATE_MODEL      (optional, default claude-sonnet-4-6)

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

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { setCors(res); return res.status(204).end(); }
  setCors(res);
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });

    // Optional: verify the request comes from a signed-in user (recommended,
    // stops strangers from spending your API credits).
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      const auth = req.headers.authorization || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (!token) return res.status(401).json({ error: "Not signed in" });
      const u = await fetch(process.env.SUPABASE_URL + "/auth/v1/user", {
        headers: { Authorization: "Bearer " + token, apikey: process.env.SUPABASE_ANON_KEY },
      });
      if (!u.ok) return res.status(401).json({ error: "Invalid session" });
    }

    const body = await readJson(req);
    const image = body && body.image;
    const mediaType = (body && body.mediaType) || "image/jpeg";
    const noteText = (body && typeof body.text === "string") ? body.text.trim() : "";
    if (!image && !noteText) return res.status(400).json({ error: "Provide a photo or a description" });

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
      const detail = await ar.text().catch(() => "");
      return res.status(502).json({ error: "Anthropic error " + ar.status, detail: detail.slice(0, 300) });
    }

    const data = await ar.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    let clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    let obj;
    try { obj = JSON.parse(clean); }
    catch {
      const m = clean.match(/\{[\s\S]*\}/);
      if (!m) return res.status(502).json({ error: "Could not parse estimate" });
      obj = JSON.parse(m[0]);
    }

    const items = Array.isArray(obj.items) ? obj.items.map(it => ({
      name: String(it.name || "Item"),
      calories: Math.max(0, Math.round(Number(it.calories) || 0)),
      protein_g: Math.max(0, Math.round(Number(it.protein_g) || 0)),
      carbs_g: Math.max(0, Math.round(Number(it.carbs_g) || 0)),
      fat_g: Math.max(0, Math.round(Number(it.fat_g) || 0)),
    })) : [];

    const sum = items.reduce((a, it) => ({
      calories: a.calories + it.calories, protein: a.protein + it.protein_g,
      carbs: a.carbs + it.carbs_g, fat: a.fat + it.fat_g,
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    return res.status(200).json({
      name: String(obj.name || "Meal"),
      description: String(obj.description || ""),
      items,
      calories: sum.calories, protein_g: sum.protein, carbs_g: sum.carbs, fat_g: sum.fat,
      confidence: obj.confidence || "medium",
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e && e.message || e).slice(0, 300) });
  }
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
