// The board page: React 18 + htm, both vendored in web/vendor (no CDN, works offline). All text comes from
// web/i18n/<lang>.json; numbers, names and times come from the server's /events stream.
'use strict';
(function () {
  if (!window.React || !window.htm) {
    document.getElementById('root').innerHTML = '<div class="err">React did not load. Raw data: <a href="/state">/state</a></div>';
    return;
  }
  const { useState, useEffect, useRef, useMemo } = React;
  const html = htm.bind(React.createElement);

  // ---------- i18n ----------
  let DICT = {}, EN = {}, LANG = 'en';
  const t = (key, vars) => {
    let s = DICT[key] != null ? DICT[key] : EN[key] != null ? EN[key] : key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  };
  async function loadLang(lang) {
    const get = l => fetch(`i18n/${l}.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
    if (!Object.keys(EN).length) EN = await get('en');
    DICT = lang === 'en' ? EN : await get(lang);
    LANG = lang;
    document.documentElement.lang = lang;
  }

  // ---------- helpers ----------
  const ICONS = {
    cpp: 'M8 5l-5 7 5 7M16 5l5 7-5 7', cook: 'M4 7h16v12H4zM8 7V5h8v2', machine: 'M3 5h18v11H3zM8 20h8M12 16v4',
    smoke: 'M5 19l4-8 4 5 3-4 3 7', editor: 'M4 4h16v16H4zM4 9h16M9 9v11', gpu: 'M4 7h16v10H4zM8 17v3M16 17v3M8 11h3v2H8z',
    box: 'M4 4h16v16H4z', person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  };
  const iconOf = r => ICONS[r.icon] || ICONS[r.id] || (r.node ? ICONS.machine : ICONS.box);
  const hue = s => { let h = 0; for (const c of String(s || '?')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
  const color = (s, a = 1) => `hsla(${hue(s)}, 62%, 56%, ${a})`;
  const dur = d => { d = Math.max(0, Math.round(d / 1000)); const h = Math.floor(d / 3600), m = Math.floor(d % 3600 / 60), s = d % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };
  const human = d => { const m = Math.round(d / 60000); return m < 1 ? t('time.lt1') : m < 60 ? t('time.min', { n: m }) : t('time.hmin', { h: Math.floor(m / 60), m: m % 60 }); };
  const hm = x => new Date(x).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });
  const ago = x => (x ? t('time.ago', { d: human(Date.now() - x) }) : '');
  const whoOf = l => (l.mode === 'presence' ? t('who.person', { m: l.chat ? l.chat.replace(/^person at /, '') : '' }) : l.chat || (l.session ? t('who.session', { id: l.session.slice(0, 8) }) : l.script || t('who.outside')));
  const STATES = ['working', 'idle', 'needs-owner', 'ended', 'gone', 'unknown'];
  const stateText = s => (STATES.includes(s) ? t('state.' + s) : s);
  const modeText = m => t('mode.' + m) !== 'mode.' + m ? t('mode.' + m) : m;

  async function post(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Hub': '1' }, body: JSON.stringify(body) });
      return await r.json();
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  function Icon({ d }) {
    return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d=${d} /></svg>`;
  }

  function OpenBtn({ host, act, small }) {
    if (!host || !host.startsWith('local_')) return null;
    return html`<button class=${'btn' + (small ? ' sm' : '')} title=${t('chat.openTitle')} onClick=${() => act('open', { hostSession: host })}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>${small ? '' : ' ' + t('chat.open')}</button>`;
  }

  // ---------- handover requests and notices ----------
  function Asks({ state, now, act }) {
    const asks = (state.asks || []).filter(a => a.state === 'pending' || a.state === 'declined');
    const notices = (state.notices || []).filter(n => n.kind === 'return' && now - n.t < 15 * 60e3);
    if (!asks.length && !notices.length) return null;
    return html`<div style=${{ marginTop: 6 }}>
      ${asks.map(a => {
        const node = (state.nodes || []).find(n => n.key === a.key);
        const machine = node ? node.label : a.label || a.key;
        const what = a.note || a.command || a.script || '';
        const again = a.state === 'declined' ? (a.declinedAt + state.handover.askAgainMin * 60e3) : 0;
        const g = node && node.probe && node.probe.gpu;
        return html`<div class="ask" key=${a.key + a.token}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--ask)" stroke-width="1.8" stroke-linecap="round"><path d=${ICONS.person} /></svg>
          <div class="q">
            <b>${t('ask.title', { from: machineLabel(state, a.machine), machine, who: a.chat || a.script || '' })}</b>
            <div>${what ? what + ' · ' : ''}${t('ask.waiting', { d: human(now - a.since) })}${a.blockedBy ? ' · ' + a.blockedBy : ''}</div>
            ${g ? html`<div>${t('ask.gpu', { used: g.usedMB, total: g.totalMB })}</div>` : null}
            ${a.state === 'declined' ? html`<div>${t('ask.declined', { time: hm(again) })}</div>` : null}
          </div>
          <div class="btns">
            <button class="btn yes" onClick=${() => act('grant', { key: a.key, token: a.token })}>${t('ask.yes')}</button>
            ${a.state === 'pending' ? html`<button class="btn no" onClick=${() => act('decline', { key: a.key, token: a.token })}>${t('ask.no')}</button>` : null}
          </div>
        </div>`;
      })}
      ${notices.map(n => html`<div class="notice" key=${n.t + n.key}><span>✓ ${noticeText(state, n)}</span><span style=${{ color: 'var(--faint)', flex: 'none' }}>${hm(n.t)}</span></div>`)}
    </div>`;
  }
  function machineLabel(state, id) {
    if (!id) return '?';
    if (id === state.hub.id) return state.hub.label;
    const n = (state.nodes || []).find(x => x.id === id);
    return n ? n.label : id;
  }
  function noticeText(state, n) {
    const node = (state.nodes || []).find(x => x.key === n.key);
    return t('notice.return', { machine: node ? node.label : n.key, who: n.who || '' });
  }

  // ---------- resource card ----------
  function ResourceCard({ r, now, history, act, hostOf }) {
    const l = r.lock;
    const person = l && !l.stale && l.mode === 'presence';
    const cls = !l ? '' : l.stale ? 'busy stale' : person ? 'person' : 'busy';
    let body;
    if (!l) {
      const last = (history || []).filter(iv => iv.res === r.key && iv.kind === 'hold' && iv.end != null).sort((a, b) => b.end - a.end)[0];
      body = last
        ? html`<div class="idle-txt">${t('res.lastHeld')}</div>
            <div class="who" style=${{ marginTop: 4 }}><span class="dot" style=${{ background: color(last.chat || last.script) }}></span><span class="grow">${last.chat || last.script}</span></div>
            <div class="sub">${human(last.end - last.start)} · ${t('res.freed', { ago: ago(last.end) })}</div>`
        : html`<div class="idle-txt">${t('res.notUsed')}</div>`;
    } else if (l.unreadable) body = html`<div class="idle-txt">${t('res.unreadable')}</div>`;
    else {
      const since = l.since, until = l.expires || since, frac = until > since ? Math.min(1, (now - since) / (until - since)) : 0;
      const host = l.hostSession || hostOf(l.session);
      body = html`
        <div class="who"><span class="dot" style=${{ background: color(whoOf(l)) }}></span><span class="grow">${whoOf(l)}</span>
          ${l.agent ? html`<span class=${'agent ' + l.agent}>${l.agent}</span>` : null}<${OpenBtn} host=${host} act=${act} small /></div>
        <div class="sub" title=${(l.script || '') + ' ' + (l.note || '')}>${modeText(l.mode)}${l.mode === 'script' && l.script ? ' · ' + l.script : ''}${l.note ? ' · ' + l.note : ''}${l.machine ? ' · ' + l.machine : ''}</div>
        <div class="timer">${dur(now - since)}</div>
        ${until > since ? html`<div class="ttl" title=${t('res.ttlUntil', { time: hm(until) })}><div style=${{ width: (frac * 100).toFixed(1) + '%', background: frac > .85 ? 'var(--warn)' : person ? 'var(--ask)' : 'var(--busy)' }}></div></div>` : null}
        <div class="sub">${t('res.since', { time: hm(since) })}${until > since ? ' · ' + t('res.ttlUntil', { time: hm(until) }) : ''}${l.stale ? ' · ' + t('res.staleWhy', { why: l.stale }) : ''}</div>
        ${l.stale ? html`<button class="btn danger" onClick=${() => {
          if (confirm(t('res.breakConfirm', { name: r.label, who: whoOf(l), why: l.stale }))) act('break', { key: r.key, token: l.token });
        }}>${t('res.break')}</button>` : null}`;
    }
    const pill = !l ? ['', t('pill.free')] : l.stale ? ['stale', t('pill.stale')] : person ? ['person', t('pill.person')] : ['busy', t('pill.busy')];
    return html`<div class=${'card ' + cls}>
      <div class="bar"></div>
      <div class="hd"><div class="nm"><${Icon} d=${iconOf(r)} /><span title=${r.key}>${r.label}</span></div><span class=${'pill ' + pill[0]}>${pill[1]}</span></div>
      ${body}
      ${r.waiters.length ? html`<div class="queue">${r.waiters.map(w => html`<div key=${w.token}>
        <span title=${w.note || w.script}>⏳ ${w.chat || w.script || w.mode}${w.blocked ? ' · ' + t('queue.forPerson') : ''}<span class="prio" title=${t('queue.priority')}>${w.priority}</span></span>
        <span>${dur(now - w.since)}</span></div>`)}</div>` : null}
    </div>`;
  }

  // ---------- machines (nodes) ----------
  function NodeCard({ n, r, now, act }) {
    const p = n.probe || {}, lock = r && r.lock && !r.lock.stale ? r.lock : null;
    const online = p.online !== false && !!p.at;
    const graceLeft = !p.busy && p.lastBusyAt && n.graceMin ? n.graceMin * 60e3 - (now - p.lastBusyAt) : 0;
    const busy = p.busy || graceLeft > 0 || !!lock;
    const pill = !p.at ? ['', t('node.noProbe')] : !online ? ['stale', t('node.offline')] : n.presence ? ['person', t('pill.person')] : busy ? ['busy', t('pill.busy')] : ['', t('pill.free')];
    const g = p.gpu, gf = g && g.totalMB ? g.usedMB / g.totalMB : 0;
    return html`<div class=${'card ' + (n.presence ? 'person' : busy ? 'busy' : '') + (!online && p.at ? ' stale' : '')}>
      <div class="bar"></div>
      <div class="hd"><div class="nm"><${Icon} d=${ICONS.machine} /><span>${n.label}</span></div><span class=${'pill ' + pill[0]}>${pill[1]}</span></div>
      <div class="sub">${[n.detail, (n.roles || []).map(x => t('role.' + x)).join(', ')].filter(Boolean).join(' · ')}</div>
      ${lock ? html`<div class="who"><span class="dot" style=${{ background: color(whoOf(lock)) }}></span><span class="grow">${whoOf(lock)}</span></div>
        <div class="sub">${modeText(lock.mode)}${lock.note ? ' · ' + lock.note : ''} · ${dur(now - lock.since)}</div>` : null}
      ${(p.desktop || []).length ? html`<div class="queue" style=${{ borderTop: 0, paddingTop: 0 }}>${p.desktop.map(d => html`<div key=${d.pid} style=${{ color: 'var(--busy)' }}><span>▶ ${d.name.replace(/\.exe$/i, '')}${d.project ? ' · ' + d.project : ''}</span><span>${d.since ? t('res.since', { time: hm(d.since) }) : d.memMB + ' MB'}</span></div>`)}</div>`
        : online && p.at ? html`<div class="idle-txt" style=${{ marginTop: 8 }}>${graceLeft > 0 ? t('node.grace', { ago: ago(p.lastBusyAt), left: human(graceLeft) }) : t('node.idle')}</div>` : null}
      ${p.load && p.load.busy ? html`<div class="sub" style=${{ color: 'var(--busy)' }}>${t('node.load')}: ${p.load.why.join('; ')}</div>` : null}
      ${g ? html`<div class="sub" style=${{ marginTop: 8 }}>${t('node.gpu', { used: g.usedMB, total: g.totalMB, util: g.util })}</div>
        <div class="ttl"><div style=${{ width: (gf * 100).toFixed(1) + '%', background: gf > .8 ? 'var(--warn)' : 'var(--busy)' }}></div></div>` : null}
      ${n.chats.length ? html`<div class="queue">${n.chats.map(c => html`<div key=${c.session} style=${{ color: 'var(--fg)' }} title=${c.lastPrompt || ''}>
          <span class="grow">${c.title || c.project}${c.title && c.project ? ' · ' + c.project : ''}</span><span class=${'st ' + c.state}>${stateText(c.state)}</span></div>`)}</div>` : null}
      <div class="sub" style=${{ marginTop: 8 }} title=${n.tunnel.error || ''}>${p.at ? t('node.probedAt', { time: hm(p.fetched || p.at) }) : t('node.neverProbed')} · ${n.transport === 'ssh-reverse' ? (n.tunnel.up ? t('node.tunnelUp') : t('node.tunnelDown') + (n.tunnel.error ? ': ' + n.tunnel.error : '')) : n.transport}${n.insecure ? ' · ' + t('node.noToken') : ''}</div>
      <div style=${{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <button class="btn" disabled=${n.probing} onClick=${() => act('node/probe', { node: n.id })}>${n.probing ? t('node.checking') : t('node.check')}</button>
        ${n.presence
          ? html`<button class="btn" onClick=${() => act('presence', { node: n.id, on: false })}>${t('node.left', { m: n.label })}</button>`
          : html`<button class="btn" title=${t('node.hereTitle')} onClick=${() => act('presence', { node: n.id, on: true })}>${t('node.here', { m: n.label })}</button>`}
      </div>
    </div>`;
  }

  // ---------- timeline ----------
  function useWidth(ref) {
    const [w, setW] = useState(800);
    useEffect(() => {
      if (!ref.current) return;
      const ro = new ResizeObserver(([e]) => setW(Math.max(160, e.contentRect.width)));
      ro.observe(ref.current);
      return () => ro.disconnect();
    }, []);
    return w;
  }

  function Timeline({ state, now, win, setTip }) {
    const ref = useRef(null);
    const W = useWidth(ref);
    const t0 = now - win;
    const x = v => Math.max(0, Math.min(W, (v - t0) / win * W));
    const locks = (state.history && state.history.locks) || [];
    const chats = (state.history && state.history.chats) || [];
    const titleOf = useMemo(() => { const m = new Map(); for (const s of state.sessions) m.set(s.session, s.title); return m; }, [state.sessions]);
    const visible = iv => (iv.end == null ? now : iv.end) > t0 && iv.start < now;
    const chatRows = [...new Set(chats.filter(visible).map(c => c.session))].slice(0, 12);
    const step = win <= 3600e3 ? 10 * 60e3 : win <= 3 * 3600e3 ? 30 * 60e3 : win <= 12 * 3600e3 ? 2 * 3600e3 : 4 * 3600e3;
    const ticks = []; for (let v = Math.ceil(t0 / step) * step; v <= now; v += step) ticks.push(v);
    const tip = (e, lines) => setTip({ x: e.clientX + 14, y: e.clientY + 12, lines });
    const H = 26;
    const track = (children, key) => html`<svg key=${key} width=${W} height=${H}>
      ${ticks.map(v => html`<line key=${v} x1=${x(v)} x2=${x(v)} y1="0" y2=${H} stroke="var(--grid)" />`)}
      <line x1="0" x2=${W} y1=${H - .5} y2=${H - .5} stroke="var(--grid)" />
      ${children}
      <line x1=${W} x2=${W} y1="0" y2=${H} stroke="var(--accent)" stroke-width="1.5" />
    </svg>`;
    const resRow = r => track(locks.filter(iv => iv.res === r.key && visible(iv)).map((iv, i) => {
      const a = x(iv.start), b = x(iv.end == null ? now : iv.end), w = Math.max(3, b - a), who = iv.chat || iv.script;
      if (['ask', 'grant', 'decline', 'return'].includes(iv.kind)) {
        return html`<circle key=${i} cx=${a} cy=${H / 2} r="4" fill=${iv.kind === 'grant' || iv.kind === 'return' ? 'var(--free)' : 'var(--ask)'} onMouseMove=${e => tip(e, [t('tl.' + iv.kind) + ': ' + who, hm(iv.start)])} onMouseLeave=${() => setTip(null)} />`;
      }
      const lines = [(iv.kind === 'hold' ? t('tl.holds') : t('tl.waits')) + ': ' + who, (iv.script || '') + (iv.note ? ' · ' + iv.note : ''), `${hm(iv.start)} – ${iv.end == null ? t('tl.now') : hm(iv.end)} · ${human((iv.end == null ? now : iv.end) - iv.start)}`];
      return iv.kind === 'hold'
        ? html`<rect key=${i} x=${a} y="5" width=${w} height=${H - 10} rx="4" fill=${iv.mode === 'presence' ? 'var(--ask)' : color(who, .9)} onMouseMove=${e => tip(e, lines)} onMouseLeave=${() => setTip(null)} />`
        : html`<rect key=${i} x=${a} y=${H / 2 - 2} width=${w} height="4" rx="2" fill="url(#hatch)" stroke=${color(who, .9)} stroke-width="1" onMouseMove=${e => tip(e, lines)} onMouseLeave=${() => setTip(null)} />`;
    }), r.key);
    const chatRow = sid => track(chats.filter(c => c.session === sid && visible(c)).map((iv, i) => {
      const a = x(iv.start), b = x(iv.end == null ? now : iv.end), w = Math.max(2, b - a);
      const lines = [titleOf.get(sid) || iv.title || sid.slice(0, 8), iv.kind === 'owner' ? t('state.needs-owner') : t('state.working'), `${hm(iv.start)} – ${iv.end == null ? t('tl.now') : hm(iv.end)} · ${human((iv.end == null ? now : iv.end) - iv.start)}`];
      return html`<rect key=${i} x=${a} y="8" width=${w} height=${H - 16} rx="3" fill=${iv.kind === 'owner' ? 'var(--warn)' : 'var(--accent)'} opacity=${iv.kind === 'owner' ? 1 : .75} onMouseMove=${e => tip(e, lines)} onMouseLeave=${() => setTip(null)} />`;
    }), sid);
    return html`<div class="panel">
      <svg width="0" height="0" style=${{ position: 'absolute' }}><defs><pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="var(--panel)" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--wait)" stroke-width="3" /></pattern></defs></svg>
      <div class="tl">
        <div>
          <div class="lab sep"></div>
          ${state.resources.map(r => html`<div key=${r.key} class="lab res" title=${r.key}>${r.label}</div>`)}
          ${chatRows.length ? html`<div class="lab sep">${t('tl.chats')}</div>` : null}
          ${chatRows.map(s => html`<div key=${s} class="lab" title=${titleOf.get(s) || s}>${titleOf.get(s) || s.slice(0, 8)}</div>`)}
        </div>
        <div ref=${ref} style=${{ minWidth: 0 }}>
          <svg width=${W} height="22">${ticks.map(v => html`<text key=${v} x=${x(v)} y="14" font-size="11" fill="var(--mut)" text-anchor="middle">${hm(v)}</text>`)}<text x=${W} y="14" font-size="11" fill="var(--accent)" text-anchor="end">${t('tl.now')}</text></svg>
          ${state.resources.map(resRow)}
          ${chatRows.length ? html`<svg width=${W} height="22"></svg>` : null}
          ${chatRows.map(chatRow)}
        </div>
      </div>
      <div class="legend">
        <span><i style=${{ background: 'hsl(30,62%,56%)' }}></i>${t('legend.hold')}</span>
        <span><i style=${{ background: 'repeating-linear-gradient(45deg, var(--wait) 0 3px, transparent 3px 6px)', height: '5px' }}></i>${t('legend.wait')}</span>
        <span><i style=${{ background: 'var(--ask)' }}></i>${t('legend.person')}</span>
        <span><i style=${{ background: 'var(--accent)', opacity: .75 }}></i>${t('legend.working')}</span>
        <span><i style=${{ background: 'var(--warn)' }}></i>${t('legend.owner')}</span>
      </div>
    </div>`;
  }

  function Load({ state, now, win }) {
    const t0 = now - win, locks = (state.history && state.history.locks) || [];
    const clip = iv => Math.max(0, Math.min(now, iv.end == null ? now : iv.end) - Math.max(t0, iv.start));
    return html`<div class="panel"><div class="load">
      ${state.resources.map(r => {
        const h = locks.filter(iv => iv.res === r.key && iv.kind === 'hold'), w = locks.filter(iv => iv.res === r.key && iv.kind === 'wait');
        const busy = h.reduce((s, iv) => s + clip(iv), 0), wait = w.reduce((s, iv) => s + clip(iv), 0);
        const takes = h.filter(iv => iv.start >= t0).length;
        return html`<${React.Fragment} key=${r.key}>
          <div class="nm" title=${r.key}>${r.label}</div>
          <div class="trk2"><div style=${{ width: (busy / win * 100) + '%', background: 'var(--busy)' }}></div><div style=${{ width: (Math.min(wait, win - busy) / win * 100) + '%', background: 'var(--wait)', opacity: .55 }}></div></div>
          <div class="num">${t('load.row', { pct: Math.round(busy / win * 100), n: takes, wait: human(wait) })}</div>
        </${React.Fragment}>`;
      })}
    </div></div>`;
  }

  function Chats({ state, all, act }) {
    const rows = state.sessions.filter(x => all || (!x.archived && x.state !== 'ended' && x.state !== 'gone'));
    if (!rows.length) return html`<div class="panel idle-txt">${t('chats.none')}</div>`;
    return html`<div class="chats">${rows.map(x => html`<div class="chat" key=${x.session}>
      <div class="t"><span title=${x.title}>${x.title || t('chats.untitled')}</span><span class=${'st ' + x.state}>${stateText(x.state)}</span></div>
      <div class="chips"><span class=${'agent ' + x.agent}>${x.agent}</span><span class="chip mach">${x.machine}</span>${x.project ? html`<span class="chip mach">${x.project}</span>` : null}
        ${x.holds.map(h => html`<span key=${'h' + h} class="chip hold">${t('chats.holds', { r: h })}</span>`)}
        ${x.waits.map(h => html`<span key=${'w' + h} class="chip wait">${t('chats.waits', { r: h })}</span>`)}
        ${x.waitingFor && !x.waits.length ? html`<span class="chip wait">${t('chats.waits', { r: x.waitingFor })}</span>` : null}</div>
      ${x.state === 'needs-owner' && x.notice ? html`<div class="pr" style=${{ color: 'var(--warn)' }}>${x.notice}</div>` : x.lastPrompt ? html`<div class="pr">${x.lastPrompt}</div>` : null}
      <div class="meta"><span>${(x.hostSession || x.session).replace('local_', '').slice(0, 8)}${x.archived ? ' · ' + t('chats.archived') : ''} · ${ago(x.last)}</span><${OpenBtn} host=${x.hostSession} act=${act} /></div>
    </div>`)}</div>`;
  }

  // ---------- notifications ----------
  function useAskAlerts(state) {
    const seen = useRef(null);
    useEffect(() => {
      if (!state) return;
      const pending = (state.asks || []).filter(a => a.state === 'pending').map(a => a.key + a.token + a.times);
      const returns = (state.notices || []).filter(n => n.kind === 'return').map(n => String(n.t));
      const keys = new Set([...pending, ...returns]);
      if (seen.current) {
        const fresh = [...keys].filter(k => !seen.current.has(k));
        if (fresh.length) {
          beep();
          if (window.Notification && Notification.permission === 'granted') {
            const a = (state.asks || []).find(x => fresh.includes(x.key + x.token + x.times));
            const n = (state.notices || []).find(x => fresh.includes(String(x.t)));
            try { new Notification(state.name, { body: a ? t('ask.title', { from: machineLabel(state, a.machine), machine: a.label || a.key, who: a.chat || a.script || '' }) : n ? noticeText(state, n) : '' }); } catch (_) {}
          }
        }
      }
      seen.current = keys;
    }, [state]);
  }
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.06;
      o.start(); o.stop(ctx.currentTime + 0.18);
    } catch (_) {}
  }

  // ---------- app ----------
  const WINDOWS = [[1, 3600e3], [3, 3 * 3600e3], [12, 12 * 3600e3], [24, 24 * 3600e3]];
  const LANG_NAMES = { en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano', es: 'Español', ru: 'Русский' };
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} } };

  function App() {
    const [state, setState] = useState(null);
    const [live, setLive] = useState(false);
    const [now, setNow] = useState(Date.now());
    // ?win=1|3|12|24 (hours) picks the timeline window for a link or a screenshot; otherwise the last choice.
    const [win, setWin] = useState(() => {
      const h = +new URLSearchParams(location.search).get('win');
      return [1, 3, 12, 24].includes(h) ? h * 3600e3 : +store.get('hub.win', 3 * 3600e3) || 3 * 3600e3;
    });
    const [all, setAll] = useState(false);
    const [tip, setTip] = useState(null);
    const [toast, setToast] = useState(null);
    const [lang, setLang] = useState(null);
    const [, force] = useState(0);
    useAskAlerts(state);
    const act = async (kind, body) => {
      const r = await post('api/' + kind, body);
      const done = { break: t('toast.broken'), open: t('toast.opening'), 'node/probe': t('toast.probing'), presence: body.on ? t('toast.here') : t('toast.left'), grant: t('toast.granted'), decline: t('toast.declined') };
      setToast({ ok: r.ok, text: r.ok ? (done[kind] || t('toast.done')) : (r.error || t('toast.failed')) });
      setTimeout(() => setToast(null), 3500);
    };
    useEffect(() => { const x = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(x); }, []);
    useEffect(() => {
      const es = new EventSource('events');
      es.onopen = () => setLive(true);
      es.onmessage = e => { try { setState(JSON.parse(e.data)); } catch (_) {} };
      es.onerror = () => setLive(false);
      return () => es.close();
    }, []);
    useEffect(() => {
      if (!state || lang) return;
      const urlLang = new URLSearchParams(location.search).get('lang');
      const nav = (navigator.language || 'en').slice(0, 2);
      const pick = [urlLang, store.get('hub.lang', ''), state.lang, nav].find(l => l && (state.langs || []).includes(l)) || 'en';
      loadLang(pick).then(() => { setLang(pick); document.title = state.name; });
    }, [state]);
    useEffect(() => { store.set('hub.win', String(win)); }, [win]);
    if (!state || !lang) return html`<div class="err">…</div>`;
    if (state.error) return html`<div class="err">${state.error}</div>`;
    const chooseLang = async l => { store.set('hub.lang', l); await loadLang(l); setLang(l); force(x => x + 1); };
    const hostOf = sid => (state.sessions.find(s => s.session === sid) || {}).hostSession || '';
    const nodeKeys = new Set((state.nodes || []).map(n => n.key));
    const res = state.resources.filter(r => !nodeKeys.has(r.key));
    const groups = [];
    for (const r of res) {
      const g = r.scope === 'project' ? r.projectLabel || r.project : t('res.machineGroup', { m: state.hub.label });
      let e = groups.find(x => x.name === g); if (!e) { e = { name: g, list: [] }; groups.push(e); }
      e.list.push(r);
    }
    const busy = state.resources.filter(r => r.lock && !r.lock.stale).length;
    const queued = state.resources.reduce((s, r) => s + r.waiters.length, 0);
    const working = state.sessions.filter(s => s.state === 'working').length;
    const owner = state.sessions.filter(s => s.state === 'needs-owner').length + (state.asks || []).filter(a => a.state === 'pending').length;
    return html`<div class="wrap">
      <div class="top">
        <div class="brand"><svg width="22" height="22" viewBox="0 0 32 32"><rect x="3" y="9" width="6" height="14" rx="2" fill="var(--busy)"/><rect x="13" y="4" width="6" height="24" rx="2" fill="var(--free)"/><rect x="23" y="12" width="6" height="10" rx="2" fill="var(--accent)"/></svg>${state.name}<small>· ${state.hub.label}</small></div>
        <span class=${'live' + (live ? ' on' : '')}><i></i>${live ? t('live.on', { time: hm(state.at) }) : t('live.off')}</span>
        <div class="kpis">
          <div class="kpi"><b>${busy}/${state.resources.length}</b><span>${t('kpi.busy')}</span></div>
          <div class="kpi"><b>${queued}</b><span>${t('kpi.queued')}</span></div>
          <div class="kpi"><b>${working}</b><span>${t('kpi.working')}</span></div>
          <div class=${'kpi' + (owner ? ' alert' : '')}><b>${owner}</b><span>${t('kpi.owner')}</span></div>
          <select class="lang" value=${lang} aria-label=${t('lang.label')} onChange=${e => chooseLang(e.target.value)}>${(state.langs || ['en']).map(l => html`<option key=${l} value=${l}>${LANG_NAMES[l] || l}</option>`)}</select>
          ${window.Notification && Notification.permission === 'default' ? html`<button class="btn" onClick=${() => Notification.requestPermission().then(() => force(x => x + 1))}>${t('notify.enable')}</button>` : null}
        </div>
      </div>

      <${Asks} state=${state} now=${now} act=${act} />

      <h2>${t('h.resources')}</h2>
      ${groups.length ? groups.map(g => html`<div key=${g.name}><h3>${g.name}</h3>
        <div class="cards">${g.list.map(r => html`<${ResourceCard} key=${r.key} r=${r} now=${now} history=${state.history.locks} act=${act} hostOf=${hostOf} />`)}</div></div>`)
        : html`<div class="panel idle-txt">${t('res.none')}</div>`}

      ${(state.nodes || []).length ? html`<h2>${t('h.machines')}</h2>
        <div class="cards">${state.nodes.map(n => html`<${NodeCard} key=${n.id} n=${n} r=${state.resources.find(r => r.key === n.key)} now=${now} act=${act} />`)}</div>` : null}

      <h2>${t('h.timeline')}<span class="sp"></span><span class="seg">${WINDOWS.map(([h, v]) => html`<button key=${v} class=${win === v ? 'on' : ''} onClick=${() => setWin(v)}>${t('tl.hours', { n: h })}</button>`)}</span></h2>
      <${Timeline} state=${state} now=${now} win=${win} setTip=${setTip} />

      <h2>${t('h.load')}</h2>
      <${Load} state=${state} now=${now} win=${win} />

      <h2>${t('h.chats')}<span class="sp"></span><label class="tog"><input type="checkbox" checked=${all} onChange=${e => setAll(e.target.checked)} /> ${t('chats.all')}</label></h2>
      <${Chats} state=${state} all=${all} act=${act} />
      ${toast ? html`<div class=${'toast' + (toast.ok ? '' : ' bad')}>${toast.text}</div>` : null}

      <details><summary>${t('h.log')}</summary><pre>${(state.log || []).join('\n') || t('log.empty')}</pre></details>
      <div class="foot">${t('foot')}</div>
      ${tip ? html`<div class="tip" style=${{ left: Math.min(tip.x, innerWidth - 330), top: tip.y }}>${tip.lines.filter(Boolean).map((l, i) => (i ? html`<div key=${i}>${l}</div>` : html`<b key=${i}>${l}</b>`))}</div>` : null}
    </div>`;
  }

  ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
})();
