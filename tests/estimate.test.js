// Run with:  node --test
// Exercises api/estimate.js with Supabase and Anthropic mocked out, so it
// needs no keys and makes no network calls.
const test = require("node:test");
const assert = require("node:assert");
const handler = require("../api/estimate.js");

const ENV = { ANTHROPIC_API_KEY: "test-key", SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon" };

function call({ method = "POST", headers = {}, body, env = ENV, user = { email: "me@example.com" },
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
                                      user: { email: "stranger@example.com" }, body: { text: "x" } });
  assert.equal(res.statusCode, 403);
  assert.ok(!calls.some((u) => u.includes("anthropic")));
  const ok = await call({ env: { ...ENV, ALLOWED_EMAILS: "Owner@Example.com" }, user: { email: "owner@example.com" }, body: { text: "x" } });
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
