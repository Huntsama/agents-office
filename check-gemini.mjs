// One check for the Gemini backend: a fake OpenAI-compatible endpoint, and the office talking to it.
// Run: node check-gemini.mjs   (no key, no network)
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const REPLY = 'PONG from the fake Gemini';
let seen = null;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => { b += d; });
  req.on('end', () => {
    seen = { auth: req.headers.authorization, body: JSON.parse(b) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: seen.body.model, choices: [{ message: { content: REPLY } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
  });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}/chat/completions`;

const port = 4599;
const srv = spawn(process.execPath, ['serve.mjs'], {
  env: { ...process.env, PORT: String(port), GEMINI_API_KEY: 'test-key', AO_GEMINI_URL: fakeUrl, AO_BRAIN: './brain' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', d => process.stderr.write(d));
const get = async p => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
try {
  for (let i = 0; i < 100; i++) { try { await get('/api/health'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }

  const before = (await get('/api/usage')).window?.tokens || 0;

  const h = await get('/api/health');
  assert.equal(h.backend, 'gemini', 'health should report the gemini backend');
  assert.equal(h.tools, false, 'no MCP tools on the gemini backend');

  const chat = await (await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'cmail', text: 'hello' }),
  })).json();
  assert.equal(chat.reply, REPLY, `agent should relay Gemini's answer, got: ${JSON.stringify(chat)}`);
  assert.equal(seen.auth, 'Bearer test-key');
  assert.match(seen.body.model, /^gemini-/);
  assert.equal(seen.body.messages[0].role, 'system');

  const u = await get('/api/usage');
  assert.equal(u.source, 'office', 'the Claude subscription gauge is skipped on gemini');
  assert.equal(u.window.tokens - before, 18, 'gemini token counts land in the office window');

  console.log('✓ gemini backend: health · chat · auth header · model id · usage —', REPLY);
} finally { srv.kill('SIGKILL'); fake.close(); }
