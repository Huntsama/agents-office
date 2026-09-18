// One check for the BC AI bridge: a fake BC AI engine, and the real office tracking it.
// Run: node check-bc.mjs   (no BC AI, no Gemini key, no network)
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// its own data dir: a check must never write into the real office's task list
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-check-'));

/* ---------- a fake BC AI on a real port ---------- */
let activity = [], sent = [], orders = [], n = 0;
const act = (agent, message) => activity.unshift({ id: 'act_' + (++n), timestamp: '10:0' + n, icon: '📍', agent, message });
const leads = [
  { id: 'L1', company: 'Centre Dentaire CALI SMILE', location: 'Casablanca', website_status: 'SOCIAL_ONLY', reviews_count: 42, has_whatsapp: true, whatsapp_pitch: 'Bonjour CALI SMILE …' },
  { id: 'L2', company: 'Déjà envoyé', has_whatsapp: true, whatsapp_pitch: 'x', outreach_sent_at: '2026-09-01' },
  { id: 'L3', company: 'Opted out', has_whatsapp: true, whatsapp_pitch: 'x', opted_out: true },
];
const bcSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => { b += d; });
  req.on('end', () => {
    const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/activity') return send({ running: true, activity });
    if (req.url === '/api/stats') return send({ total_leads: 3, audits_generated: 3, revenue_closed: 0 });
    if (req.url === '/api/leads') return send(leads);
    if (req.url === '/api/master-order') { orders.push(JSON.parse(b).order); act('Master Orchestrator', 'Ordre reçu'); return send({ ok: true }); }
    if (req.url === '/api/wa/send') { sent.push(JSON.parse(b).lead_id); return send({ ok: true }); }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(r => bcSrv.listen(0, '127.0.0.1', r));
const bcUrl = `http://127.0.0.1:${bcSrv.address().port}`;

/* ---------- the real office, pointed at it ---------- */
const port = 4598;
const srv = spawn(process.execPath, ['serve.mjs'], {
  env: { ...process.env, AO_DATA: DATA_DIR, PORT: String(port), AO_BC_URL: bcUrl, GEMINI_API_KEY: 'unused-here' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', d => process.stderr.write(d));
const api = async (p, init) => (await fetch(`http://127.0.0.1:${port}${p}`, init)).json();
const post = (p, o) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
const tasks = () => api('/api/tasks');
const wait = ms => new Promise(r => setTimeout(r, ms));

try {
  for (let i = 0; i < 100; i++) { try { await api('/api/health'); break; } catch { await wait(200); } }
  for (const t of await tasks()) if (String(t.id).startsWith('bc-')) await api('/api/tasks/' + t.id, { method: 'DELETE' });

  // 1. the pod is BC AI's crew
  const h = await api('/api/health');
  const sales = Object.fromEntries(h.agents.filter(a => a.department === 'sales').map(a => [a.id, a.name]));
  assert.equal(sales.pros, 'MAPS MINER');
  assert.equal(sales.piper, 'PITCH WRITER');
  assert.equal(sales.ilm, 'WHATSAPP CLOSER');

  // 2. activity lands on the right desks, live
  act('Google Maps', '47 fiches extraites pour "dentiste" à Casablanca');
  act('Stratège IA', 'Pitch rédigé pour CALI SMILE');
  const bc = await api('/api/bc?refresh=1');
  assert.equal(bc.enabled, true);
  assert.equal(bc.running, true);
  assert.equal(bc.stats.total_leads, 3);

  let list = await tasks();
  const miner = list.find(t => t.bc === 'run' && t.agent === 'pros');
  const writer = list.find(t => t.bc === 'run' && t.agent === 'piper');
  assert.ok(miner, 'the Maps line should open a card on the MAPS MINER desk');
  assert.equal(miner.state, 'doing', 'the desk should be busy while the run is live');
  assert.match(miner.title, /47 fiches/);
  assert.ok(writer && writer.agent === 'piper', 'the pitch line belongs to PITCH WRITER, not the miner');

  // a second line on the same desk appends to the same card
  act('Google Maps', '12 sans site web');
  await api('/api/bc?refresh=1');
  const miner2 = (await tasks()).find(t => t.id === miner.id);
  assert.match(miner2.result, /47 fiches[\s\S]*12 sans site/, 'the card keeps the whole run');

  // 3. one unsent pitch is held for the owner; sent and opted-out ones are not
  assert.equal(bc.pending, 1, 'only L1 is pitch-ready and unsent');
  const held = (await tasks()).filter(t => t.bc === 'pitch');
  assert.equal(held.length, 1);
  assert.equal(held[0].agent, 'ilm', 'a held pitch waits on the closer desk');
  assert.equal(held[0].state, 'waiting');
  assert.match(held[0].result, /CALI SMILE/);
  assert.equal(sent.length, 0, 'NOTHING may leave the machine before the tick');

  // 4. an order typed in the office reaches BC AI — both the API and the "BC ..." bar prefix
  await post('/api/bc/order', { order: '20 cliniques dentaires à Casablanca' });
  assert.deepEqual(orders, ['20 cliniques dentaires à Casablanca']);

  const bar = await post('/api/tasks', { dept: 'sales', text: 'BC 15 dentistes à Rabat' });
  assert.equal(bar.bc, 'order', 'the BC prefix must not spend a model call');
  assert.equal(bar.agent, 'lexi', 'the order sits on the orchestrator desk');
  for (let i = 0; i < 40 && orders.length < 2; i++) await wait(50);
  assert.deepEqual(orders[1], '15 dentistes à Rabat', 'the bar order reached BC AI, stripped of the prefix');

  // 5. reject holds it back; approve is the one thing that sends
  await post(`/api/tasks/${held[0].id}/reject`, { feedback: 'trop long' });
  assert.equal(sent.length, 0, 'a rejected pitch must not be sent');
  let after = (await tasks()).find(t => t.id === held[0].id);
  assert.equal(after.state, 'done');
  assert.match(after.result, /not sent/);

  // a fresh pitch-ready lead, ticked this time: approve is the only path that reaches a prospect
  leads.push({ id: 'L4', company: 'Clinique Atlas', has_whatsapp: true, whatsapp_pitch: 'Bonjour Atlas …' });
  await api('/api/bc?refresh=1');
  const fresh = (await tasks()).find(t => t.bc === 'pitch' && t.lead === 'L4' && t.state === 'waiting');
  assert.ok(fresh, 'the new pitch should be waiting on the closer desk');
  const r = await post(`/api/tasks/${fresh.id}/approve`);
  assert.equal(r.sent, true);
  assert.deepEqual(sent, ['L4'], 'approve sends exactly that lead, once');
  assert.equal((await tasks()).find(t => t.id === fresh.id).state, 'done');

  console.log('✓ bc bridge: pod renamed · activity → desks · run cards · pitch held · reject held back · orders fired (api + bar) · approve sent L4');
} finally { srv.kill('SIGKILL'); fs.rmSync(DATA_DIR, { recursive: true, force: true }); bcSrv.close(); }
