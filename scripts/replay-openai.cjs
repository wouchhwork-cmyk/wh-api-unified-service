/*
 * Replays a captured prompt against OpenAI, to separate "the prompt is not
 * good enough" from "this model will not do it".
 *
 *   node --env-file=.env.dev scripts/replay-openai.cjs [gpt-6-luna]
 *
 * READ ONLY. Same idea as replay-prompt.cjs, other provider: it sends the
 * exact bytes a capture recorded and prints which tool, if any, comes back.
 * When two models disagree on identical input, the input is not the problem.
 */
const fs = require('node:fs');
const path = require('node:path');
const OpenAI = require('openai');

const dir = 'var/ai-wire';
const want = process.env.PROBE_MESSAGE_ID;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
let picked = null;
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!want || String(d.messageId) === want) picked = { f, d };
}
if (!picked) { console.log('no capture found'); process.exit(1); }

const req = picked.d.request;
const text = Array.isArray(req.input) && req.input[0] && req.input[0].text ? req.input[0].text : null;
const instructions = req.instructions || '';
if (!text && !instructions) { console.log('capture has no readable prompt'); process.exit(1); }

const model = process.argv[2] || process.env.OPENAI_MODEL || 'gpt-6-luna';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
  console.log('capture   :', picked.f, '| message', picked.d.messageId, '| round', picked.d.round);
  console.log('replaying against:', model);
  const started = Date.now();
  try {
    const raw = await client.responses.create({
      model, store: false,
      ...(instructions ? { instructions } : {}),
      input: text ? [{ role: 'user', content: text }] : req.input,
    });
    const out = raw.output_text || JSON.stringify(raw).slice(0, 400);
    let parsed = null;
    try { parsed = JSON.parse((out.match(/\{[\s\S]*\}/) || [out])[0]); } catch {}
    console.log('took      :', Date.now() - started, 'ms');
    console.log('tool      :', parsed ? JSON.stringify(parsed.tool) : '(unparseable)');
    console.log('handoff   :', parsed ? JSON.stringify(parsed.handoff) : '-');
    console.log('reply     :', parsed ? String(parsed.reply || '').slice(0, 160) : out.slice(0, 160));
  } catch (e) {
    console.log('FAILED after', Date.now() - started, 'ms:', String(e.message).slice(0, 140));
  }
})();
