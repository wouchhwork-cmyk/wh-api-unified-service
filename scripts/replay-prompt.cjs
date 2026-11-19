/*
 * Replays the EXACT captured prompt against one or more models.
 *
 *   node --env-file=.env.dev scripts/replay-prompt.cjs gemini-3.5-flash-lite
 *
 * READ ONLY: no database, no Nest, no settings touched. It reads the bytes
 * AI_WIRE_CAPTURE already stored and sends them again — which is the one
 * question the capture exists to answer: is it the frame or the model?
 *
 * IT SETTLED EXACTLY THAT, ONCE. The assistant would not call a read tool,
 * through three rounds of prompt fixes — new rules, a rewritten tool
 * description, a marker in <person> saying a phone number was on file. None
 * of it moved `gemini-3.1-flash-lite`. The same 44,000 bytes handed to
 * `gemini-3.5-flash-lite` produced the tool call first time, every time.
 *
 * So the frame was right the whole way through and the model could not use
 * it. Nothing short of replaying the real bytes could have told the two
 * apart, and all three prompt fixes were made in the dark before this ran.
 */
const fs = require('node:fs');
const path = require('node:path');
const { GoogleGenAI } = require('@google/genai');

const dir = 'var/ai-wire';
const file = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().pop();
const captured = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const prompt = captured.request.input[0].text;

const models = process.argv.slice(2);
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { apiVersion: process.env.GEMINI_API_VERSION || 'v1beta' },
});

function textOf(raw) {
  if (typeof raw?.output_text === 'string') return raw.output_text;
  const out = raw?.output;
  if (Array.isArray(out)) {
    const parts = [];
    for (const item of out) {
      for (const c of item?.content ?? []) if (typeof c?.text === 'string') parts.push(c.text);
    }
    if (parts.length) return parts.join('');
  }
  return JSON.stringify(raw).slice(0, 400);
}

(async () => {
  console.log('prompt from :', file, '(' + prompt.length + ' chars)');
  for (const model of models) {
    try {
      const raw = await ai.interactions.create({ model, store: false, input: [{ type: 'text', text: prompt }] });
      const text = textOf(raw);
      let tool = 'unparseable';
      try {
        const m = text.match(/\{[\s\S]*\}/);
        const obj = JSON.parse(m ? m[0] : text);
        tool = obj.tool ? JSON.stringify(obj.tool) : 'null';
        console.log(`\n${model}\n  tool  : ${tool}\n  reply : ${(obj.reply || '').slice(0, 160)}`);
      } catch {
        console.log(`\n${model}\n  RAW   : ${text.slice(0, 300)}`);
      }
    } catch (e) {
      console.log(`\n${model}\n  FAILED: ${e.message.slice(0, 160)}`);
    }
  }
})();
