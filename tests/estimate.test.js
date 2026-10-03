// Run with:  node --test
// Exercises api/estimate.js with Supabase and Anthropic mocked out, so it
// needs no keys and makes no network calls.
const test = require("node:test");
const assert = require("node:assert");
const handler = require("../api/estimate.js");

const ENV = { ANTHROPIC_API_KEY: "test-key", SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon" };

function call({ method = "POST", headers = {}, body, env = ENV, user = { id: "u-default", email: "me@example.com" },
                claude = { name: "Toast", items: [{ name: "Bread", calories: 80.6, protein_g: 3, carbs_g: 15, fat_g: 1 }] } } = {}) {
  const saved = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "ALLOWED_EMAILS", "ALLOWED_ORIGIN"]) delete process.env[k];
  Object.assign(process.env, env);
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(url);
    if (url.endsWith("/auth/v1/user")) {
      const ok = (opts.headers.Authorization || "") === "Bearer good";
      return { ok, json: async () => user };
    }
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(claude) }] }) };
  };
  const res = { headers: {}, statusCode: 0, payload: undefined,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(o) { this.payload = o; return this; }, end() { return this; } };
  const req = { method, headers: { authorization: "Bearer good", ...headers }, body };
  return Promise.resolve(handler(req, res)).then(() => { process.env = saved; return { res, calls }; });
}

test("estimates a described meal for a signed-in user", async () => {
  const { res } = await call({ body: { text: "two slices of toast" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.calories, 81);
  assert.equal(res.payload.items[0].name, "Bread");
});

test("fails closed when Supabase is not configured", async () => {
  const { res, calls } = await call({ env: { ANTHROPIC_API_KEY: "k" }, body: { text: "x" } });
  assert.equal(res.statusCode, 500);
  assert.equal(calls.length, 0, "must not call Anthropic");
});

test("rejects missing and invalid sessions", async () => {
  assert.equal((await call({ headers: { authorization: "" }, body: { text: "x" } })).res.statusCode, 401);
  assert.equal((await call({ headers: { authorization: "Bearer bad" }, body: { text: "x" } })).res.statusCode, 401);
});

test("ALLOWED_EMAILS blocks other accounts before spending credits", async () => {
  const { res, calls } = await call({ env: { ...ENV, ALLOWED_EMAILS: "owner@example.com" },
                                      user: { id: "s1", email: "stranger@example.com" }, body: { text: "x" } });
  assert.equal(res.statusCode, 403);
  assert.ok(!calls.some((u) => u.includes("anthropic")));
  const ok = await call({ env: { ...ENV, ALLOWED_EMAILS: "Owner@Example.com" }, user: { id: "o1", email: "owner@example.com" }, body: { text: "x" } });
  assert.equal(ok.res.statusCode, 200);
});

test("validates input", async () => {
  assert.equal((await call({ body: {} })).res.statusCode, 400);
  assert.equal((await call({ body: { image: "aaaa", mediaType: "text/html" } })).res.statusCode, 400);
  assert.equal((await call({ body: { text: "x".repeat(1001) } })).res.statusCode, 400);
  assert.equal((await call({ body: { image: "a".repeat(4 * 1024 * 1024 + 1) } })).res.statusCode, 413);
  assert.equal((await call({ body: "{not json" })).res.statusCode, 400);
});

test("does not send CORS headers to other origins", async () => {
  const { res } = await call({ headers: { origin: "https://evil.example" }, body: { text: "x" } });
  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  const mine = await call({ env: { ...ENV, ALLOWED_ORIGIN: "https://plate.example" },
                            headers: { origin: "https://plate.example" }, body: { text: "x" } });
  assert.equal(mine.res.headers["Access-Control-Allow-Origin"], "https://plate.example");
});

test("cleans up a sloppy model reply", async () => {
  const { res } = await call({ body: { text: "x" },
    claude: { name: "M", confidence: "certain", items: [{ name: "A", calories: -5, protein_g: "7" }] } });
  assert.equal(res.payload.items[0].calories, 0);
  assert.equal(res.payload.items[0].protein_g, 7);
  assert.equal(res.payload.confidence, "medium");
});

test("rate limit trips after the per-user budget and resets after the window", () => {
  const rl = handler._rateLimited;
  const t0 = 1_000_000;
  for (let i = 0; i < 30; i++) assert.equal(rl("u-rate", t0 + i), false);
  assert.equal(rl("u-rate", t0 + 31), true);
  assert.equal(rl("u-other", t0 + 31), false);
  assert.equal(rl("u-rate", t0 + 10 * 60 * 1000 + 100), false);
});

test("a retired model gives an actionable error", async () => {
  const saved = global.fetch;
  const { res } = await (async () => {
    Object.assign(process.env, ENV);
    global.fetch = async (url) => url.endsWith("/auth/v1/user")
      ? { ok: true, json: async () => ({ id: "u404", email: "me@example.com" }) }
      : { ok: false, status: 404, text: async () => "model not found" };
    const r = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
      json(o) { this.payload = o; return this; }, end() { return this; } };
    await handler({ method: "POST", headers: { authorization: "Bearer good" }, body: { text: "x" } }, r);
    return { res: r };
  })();
  global.fetch = saved;
  assert.equal(res.statusCode, 502);
  assert.match(res.payload.error, /ESTIMATE_MODEL/);
});

test("odd model replies are rejected or clamped, never crash", async () => {
  for (const claude of [null, 42, "text", [1, 2]]) {
    const { res } = await call({ body: { text: "x" }, claude, user: { id: "odd-" + String(claude), email: "me@example.com" } });
    assert.equal(res.statusCode, 502, JSON.stringify(claude));
  }
  const many = { name: "M", items: [null, "x", ...Array.from({ length: 80 }, () => ({ name: "a", calories: 1e9, protein_g: -3 }))] };
  const { res } = await call({ body: { text: "x" }, claude: many, user: { id: "odd-many", email: "me@example.com" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.items.length, 20);          // 20 × 5000 kcal stays inside the database limit
  assert.equal(res.payload.items[0].calories, 5000);
  assert.equal(res.payload.items[0].protein_g, 0);
});

test("a malformed user record from Supabase is treated as not signed in", async () => {
  for (const user of [null, {}, { email: "a@b.c" }]) {
    const { res, calls } = await call({ body: { text: "x" }, user });
    assert.equal(res.statusCode, 401);
    assert.ok(!calls.some((u) => u.includes("anthropic")));
  }
});
