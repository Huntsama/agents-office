// Agents Office — configuration (Beta).
// office.config.json is the shipped default; office.config.local.json (gitignored) overrides it;
// environment variables override both: AO_NAME, AO_BRAIN, PORT, AO_MODEL.
// V3.1 keys: mcp { allow, deny, departments } · tools { web } · timeout (seconds per agent run) — see mcp.mjs.
// V3.2 (16 Sep) keys: tools { browser } (Claude in Chrome for the agents, default on) · teams { enabled, max } (Agent Teams, default on, up to 4 desks) — see teams.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

export function loadConfig() {
  const base = readJSON(path.join(ROOT, 'office.config.json'));
  const local = readJSON(path.join(ROOT, 'office.config.local.json'));
  const c = { name: 'Agents Office', brain: './brain', port: 4520, model: 'sonnet', ...base, ...local }; // V3.6: model = sonnet · opus · fable
  c.mcp = { allow: [], deny: [], departments: {}, ...(base.mcp || {}), ...(local.mcp || {}) };
  c.tools = { web: true, browser: true, ...(base.tools || {}), ...(local.tools || {}) }; // V3.2 (16 Sep): browser = Claude in Chrome
  c.teams = { enabled: true, max: 4, ...(base.teams || {}), ...(local.teams || {}) }; // V3.2 (16 Sep): Agent Teams
  // BC AI: the sales pod tracks the BC AI engine. `start` = bring it up with the office. Sends are
  // held for the owner's tick whatever this says — see bc.mjs.
  c.bc = { enabled: false, url: 'http://127.0.0.1:3000', dir: '', start: true, ...(base.bc || {}), ...(local.bc || {}) };
  if (process.env.AO_BC_URL) { c.bc.url = process.env.AO_BC_URL; c.bc.enabled = true; }
  if (process.env.AO_BC_DIR) { c.bc.dir = process.env.AO_BC_DIR; c.bc.enabled = true; }
  if (process.env.AO_BC === '0') c.bc.enabled = false;
  if (process.env.AO_NAME) c.name = process.env.AO_NAME;
  if (process.env.AO_BRAIN) c.brain = process.env.AO_BRAIN;
  if (process.env.PORT) c.port = +process.env.PORT;
  if (process.env.AO_MODEL) c.model = process.env.AO_MODEL;
  c.port = +c.port || 4520;
  c.brainPath = path.resolve(ROOT, c.brain);
  return c;
}
