// Shared helpers of the board page: states, resource colours and icons, time formatting, the page's own actions.
import { LANG, has, t } from './i18n.js';

// Chat states and their colours (Mantine palette names). Labels: state.<name> in the dictionaries.
export const STATE_COLOR = {
  'needs-owner': 'orange', stalled: 'red', working: 'green', background: 'cyan', idle: 'blue', unknown: 'gray', gone: 'gray', ended: 'dark',
};
export const RANK = { 'needs-owner': 0, stalled: 1, working: 2, background: 3, idle: 4, unknown: 5, gone: 6, ended: 7 };
export const stateText = s => (has('state.' + s) ? t('state.' + s) : s);
/** What a state means (tooltip): state.tip.<name>. */
export const stateTip = s => (has('state.tip.' + s) ? t('state.tip.' + s) : '');

// "Working" with no hook event for an hour: the chat most likely died.
const STALL_MS = 60 * 60e3;
export const viewState = s => (s.state === 'working' && s.last && Date.now() - s.last > STALL_MS ? 'stalled' : s.state);
export const isClosed = s => s.archived || s.state === 'ended' || s.state === 'gone';
export const isActive = s => !s.archived && ['working', 'needs-owner', 'idle', 'background'].includes(s.state);

// Resources: colour from the config (`color`: a Mantine colour name or any CSS colour), else from the icon, else a
// stable colour from the key. Icons: cpp cook machine smoke editor gpu box (docs/CONFIG.md).
const PALETTE = ['blue', 'orange', 'violet', 'pink', 'teal', 'grape', 'lime', 'cyan', 'yellow', 'indigo'];
const MANTINE = new Set(['dark', 'gray', 'red', 'pink', 'grape', 'violet', 'indigo', 'blue', 'cyan', 'teal', 'green', 'lime', 'yellow', 'orange']);
const BY_ICON = { editor: 'violet', cpp: 'blue', cook: 'orange', smoke: 'pink', machine: 'teal', gpu: 'teal', box: 'indigo' };
export function resColorName(r) {
  if (!r) return 'indigo';
  if (r.color && MANTINE.has(r.color)) return r.color;
  if (r.color) return null;
  return BY_ICON[r.icon] || BY_ICON[r.id] || (r.node ? 'teal' : PALETTE[hue(r.key || r.id) % PALETTE.length]);
}
/** A CSS colour for a resource record. */
export const resColor = r => {
  const n = resColorName(r);
  return n ? `var(--mantine-color-${n}-6)` : r.color;
};

export const BG_COLOR = { shell: 'grape', subagent: 'indigo', monitor: 'yellow', workflow: 'violet', teammate: 'lime', 'cloud session': 'cyan' };
export const bgType = type => {
  const k = String(type || '').toLowerCase();
  const key = k === 'cloud session' ? 'bg.cloud' : 'bg.' + k;
  return { label: k && has(key) ? t(key) : type || t('bg.task'), color: BG_COLOR[k] || 'gray' };
};

export function hue(s) { let h = 0; for (const c of String(s || '?')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
export const chatColor = (s, a = 1) => `hsla(${hue(s)}, 58%, 55%, ${a})`;
export const ms = s => (typeof s === 'number' ? s : Date.parse(s) || 0);
export const dur = d => {
  d = Math.max(0, Math.round(d / 1000));
  const h = Math.floor(d / 3600), m = Math.floor(d % 3600 / 60), s = d % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
export const human = d => { const m = Math.round(d / 60000); return m < 1 ? t('time.lt1') : m < 60 ? t('time.min', { n: m }) : t('time.hmin', { h: Math.floor(m / 60), m: m % 60 }); };
export const hm = x => new Date(x).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });
export const ago = x => (x ? t('time.ago', { d: human(Date.now() - x) }) : '—');
export const full = x => (x ? new Date(x).toLocaleString(LANG) : '');
export const whoOf = l => (l.mode === 'presence' ? t('who.person', { m: l.chat ? l.chat.replace(/^person at /, '') : '' })
  : l.chat || (l.session ? t('who.session', { id: l.session.slice(0, 8) }) : l.script || t('who.outside')));
export const modeText = m => (has('mode.' + m) ? t('mode.' + m) : m);
export const tickStep = win => (win <= 3600e3 ? 10 * 60e3 : win <= 3 * 3600e3 ? 30 * 60e3 : win <= 12 * 3600e3 ? 2 * 3600e3 : 4 * 3600e3);
export const clip = (s, n) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  raw(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } },
  setRaw(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};

// Page actions carry X-Agent-Hub: a page from another origin cannot send it without a CORS preflight.
export async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Hub': '1' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

export function machineLabel(state, id) {
  if (!id) return '?';
  if (id === state.hub.id) return state.hub.label;
  const n = (state.nodes || []).find(x => x.id === id);
  return n ? n.label : id;
}
