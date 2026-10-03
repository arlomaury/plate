const test = require('node:test');
const assert = require('node:assert');
const handler = require('../api/estimate.js');
let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const junk = [null, undefined, '', 'x', 'x'.repeat(2000), 5, -1, true, [], {}, { a: 1 }, 'image/png', 'text/html', 'a'.repeat(5e6), '\u0000', 'ok meal'];
process.env.ANTHROPIC_API_KEY = 'k'; process.env.SUPABASE_URL = 'https://sb'; process.env.SUPABASE_ANON_KEY = 'a';
const replies = [null, 1, 'str', [], {}, { items: 'x' }, { items: [null, 1, { calories: 'abc' }] }, { name: { x: 1 }, items: [{ name: ['a'], calories: 1e30 }] }, { name: 'ok', items: [{ name: 'a', calories: 100 }] }];
const bad = {}; let n = 0;
test('estimate API never crashes and never returns out-of-range meals on random input', async () => {
  const saved = { ...process.env }; const savedErr = console.error; console.error = () => {};
  for (let i = 0; i < 1500; i++) {
    const reply = pick(replies);
    global.fetch = async (url) => url.endsWith('/auth/v1/user')
      ? (rnd() < 0.1 ? { ok: false } : { ok: true, json: async () => pick([{ id: 'u' + i, email: 'a@b.c' }, {}, null, { email: 5 }]) })
      : (rnd() < 0.1 ? { ok: false, status: pick([400, 401, 404, 429, 500, 529]), text: async () => 'e' }
        : { ok: true, json: async () => pick([{ content: [{ type: 'text', text: JSON.stringify(reply) }] }, { content: null }, {}, { content: [{ type: 'text', text: '```json\n' + JSON.stringify(reply) + '\n```' }] }]) });
    const body = pick([undefined, 'not json', '{"text":"a"}', { image: pick(junk), mediaType: pick(junk), text: pick(junk) }, { text: pick(junk) }]);
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
    const req = { method: pick(['POST', 'POST', 'GET', 'OPTIONS']), headers: { authorization: pick(['Bearer t', '', 'Basic x', undefined]), origin: pick([undefined, 'https://evil']) }, body };
    try { await handler(req, res); n++; } catch (e) { bad['THREW ' + e.message] = (bad['THREW ' + e.message] || 0) + 1; continue; }
    if (res.code === 500) bad['500 ' + JSON.stringify(res.body)] = (bad['500 ' + JSON.stringify(res.body)] || 0) + 1;
    if (res.code === 200) {
      const b = res.body;
      if (!Array.isArray(b.items) || b.items.length > 20 || !b.items.every((it) => Number.isInteger(it.calories) && it.calories >= 0 && it.calories <= 5000 && typeof it.name === 'string'))
        bad['bad 200 body'] = (bad['bad 200 body'] || 0) + 1;
      if (b.calories > 100000) bad['total too big'] = 1;
    }
    if (res.headers['Access-Control-Allow-Origin']) bad['cors leaked'] = 1;
  }
  console.error = savedErr; process.env = saved;
  assert.deepStrictEqual(bad, {});
  assert.equal(n, 1500);
});
