// Agents Office ← BC AI. The office is the tracker: BC AI's swarm (Maps miner, audit brain,
// pitch writer, WhatsApp closer) shows up as the six SALES desks, and what each one is doing
// right now becomes an ordinary office task — so the existing 3D floor, the desk cards and the
// approval tick all work with no new UI.
//
// Two directions:
//   · watch  — poll BC AI's /api/activity + /api/stats + /api/leads, turn them into tasks
//   · drive  — POST an order to BC AI, and send a held pitch once the owner ticks it
//
// The sends are held on purpose: mining, auditing and writing pitches happen freely, but a
// WhatsApp message to a real prospect waits on a `waiting` task until the owner approves it.

// Which BC AI agent sits at which desk. BC AI names its agents in the activity feed; anything
// not listed here lands on the lead's desk, so a new agent still shows up rather than vanishing.
export const DESK_OF = {
  'Master Orchestrator': 'lexi',
  'Autopilot': 'lexi',
  'API': 'lexi',
  'Google Maps': 'pros',
  'Agent 1: Google Maps': 'pros',
  'Stratège IA': 'piper',
  'One-pager': 'piper',
  'Agent WhatsApp': 'ilm',
  'Testeur': 'ilm',
  'Relance': 'folo',
  'Mémoire': 'enzo',
  'Plugin': 'enzo',
};
export const LEAD_DESK = 'lexi';       // the orchestrator's desk: unmapped agents and master orders
export const CLOSER_DESK = 'ilm';      // where a pitch waits for the owner's tick
export const DEPT = 'sales';
const RUN_IDLE = 45000;                // no new line for this long → that desk's run is finished

export const deskFor = agent => DESK_OF[agent] || LEAD_DESK;

/** A lead BC AI has written a pitch for but not sent: the only thing the owner has to tick. */
export const pitchPending = l => !!(l && l.whatsapp_pitch && l.has_whatsapp && !l.outreach_sent_at && !l.opted_out);

/** One activity entry → the line shown on the desk card. */
export const lineOf = a => `${a.icon || '·'} ${a.timestamp || ''} ${a.message || ''}`.trim();

export function create({ url = 'http://127.0.0.1:3000', load, save, every = 3000, log = () => {} } = {}) {
  const base = url.replace(/\/$/, '');
  let seen = new Set();          // activity ids already turned into task lines
  let runs = new Map();          // desk → { taskId, lastAt }
  let state = { on: false, running: false, stats: null, leads: 0, pending: 0, reason: 'not polled yet', at: 0 };
  let timer = null;

  const call = async (p, init) => {
    const r = await fetch(base + p, { ...init, signal: AbortSignal.timeout(20000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `BC AI answered ${r.status}`);
    return body;
  };

  /** Append one activity line to that desk's current run, opening a task if the run is new. */
  function record(entry, list, now) {
    const desk = deskFor(entry.agent);
    const run = runs.get(desk);
    let task = run && list.find(t => t.id === run.taskId);
    if (!task || now - run.lastAt > RUN_IDLE) {
      task = { id: 'bc-' + desk + '-' + now.toString(36), dept: DEPT, agent: desk, bc: 'run',
        title: entry.message || entry.agent, text: `BC AI — ${entry.agent}`, why: 'live from BC AI',
        plan: [], eta: 0, state: 'doing', addedAt: now, startedAt: now, by: 'BC AI', result: '' };
      list.push(task);
    }
    task.title = entry.message || task.title;      // the card shows what the agent is on right now
    task.result = (task.result ? task.result + '\n' : '') + lineOf(entry);
    task.state = 'doing';
    runs.set(desk, { taskId: task.id, lastAt: now });
  }

  /** A run nobody has added to for RUN_IDLE is over: close its card. */
  function closeIdle(list, now) {
    for (const [desk, run] of runs) {
      if (now - run.lastAt <= RUN_IDLE) continue;
      const t = list.find(x => x.id === run.taskId);
      if (t && t.state === 'doing') { t.state = 'done'; t.doneAt = now; t.error = false; }
      runs.delete(desk);
    }
  }

  /** Every unsent pitch gets one card on the closer's desk, waiting for the owner's tick. */
  function holdPitches(leads, list, now) {
    let pending = 0;
    for (const l of leads) {
      if (!pitchPending(l)) continue;
      pending++;
      const id = 'bc-lead-' + l.id;
      if (list.some(t => t.id === id)) continue;
      list.push({ id, dept: DEPT, agent: CLOSER_DESK, bc: 'pitch', lead: l.id,
        title: `Pitch ready — ${l.company || l.id}`, text: `Send this WhatsApp pitch to ${l.company || l.id}.`,
        why: 'held: nothing leaves this machine without your tick', plan: [], eta: 0,
        // waitingAt + ask + draft are what the office's approval card keys on (src/tasks.js apply)
        state: 'waiting', needsOk: true, waitingAt: now, addedAt: now, by: 'BC AI',
        ask: `Send this pitch to ${l.company || l.id} on WhatsApp?`,
        draft: l.whatsapp_pitch,
        result: [l.company && `*${l.company}*${l.location ? ' — ' + l.location : ''}`,
          l.website_status && `status: ${l.website_status}${l.reviews_count ? ` · ${l.reviews_count} reviews` : ''}`,
          '', l.whatsapp_pitch].filter(Boolean).join('\n') });
    }
    // a pitch sent (or opted out) outside the office: drop the stale card
    const live = new Set(leads.filter(pitchPending).map(l => 'bc-lead-' + l.id));
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (t.bc === 'pitch' && t.state === 'waiting' && !live.has(t.id)) list.splice(i, 1);
    }
    return pending;
  }

  async function tick() {
    const now = Date.now();
    try {
      const [act, stats, leads] = await Promise.all([call('/api/activity'), call('/api/stats'), call('/api/leads')]);
      const list = load();
      const fresh = (act.activity || []).filter(a => a.id && !seen.has(a.id)).reverse(); // the feed is newest-first
      for (const a of fresh) { seen.add(a.id); record(a, list, now); }
      if (seen.size > 500) seen = new Set([...seen].slice(-250));
      closeIdle(list, now);
      const pending = holdPitches(leads || [], list, now);
      save(list);
      state = { on: true, running: !!act.running, stats, leads: (leads || []).length, pending, reason: '', at: now };
      if (fresh.length) log(`bc: ${fresh.length} new line${fresh.length > 1 ? 's' : ''} → ${[...new Set(fresh.map(a => deskFor(a.agent)))].join(', ')}`);
    } catch (e) {
      state = { ...state, on: false, reason: e.message, at: now };
    }
  }

  return {
    state: () => state,
    start() { if (!timer) { tick(); timer = setInterval(tick, every); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
    tick,
    /** Fire a master order at BC AI. Mining, auditing and pitching only — sends still wait. */
    order: (order, filters) => call('/api/master-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order, filters: filters || {} }) }),
    /** The owner ticked a held pitch: this is the only call that reaches a prospect. */
    send: leadId => call('/api/wa/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: leadId }) }),
  };
}
