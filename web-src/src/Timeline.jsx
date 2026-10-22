import { useMemo, useState } from 'react';
import { Button, Group, Paper, SegmentedControl, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { t } from './i18n.js';
import { STATE_COLOR, chatColor, clip, hm, human, isClosed, resColor, store, viewState } from './util.js';

const EVENT_KINDS = ['ask', 'grant', 'decline', 'return'];
// How much time fits the visible width; the rest of the window scrolls to the right, into the past.
const ZOOMS = [1, 2, 4];

// Resources and chats on one time axis with "now" at the left edge next to the names: what happens now is read
// first, older hours scroll away to the right. Holds are bars (a person's presence in amber), queues hatched,
// handover events dots, chat turns one bar per turn (working, working in the background, needs you).
export default function Timeline({ state, now, win, setTip }) {
  const { ref, width } = useElementSize();
  const [zoom, setZoom] = useState(() => store.get('hub.zoom', 2 * 3600e3));
  const [allChats, setAllChats] = useState(false);
  const W = Math.max(320, Math.floor(width || 900));
  const LW = W < 760 ? 140 : 220;
  const view = W - LW - 2, span = Math.max(win, zoom), perMs = view / Math.min(zoom, span), total = Math.ceil(span * perMs);
  const X = v => Math.max(0, Math.min(total, (now - v) * perMs));
  const t0 = now - span;
  const resources = state.resources;
  const locks = (state.history && state.history.locks) || [];
  const chats = (state.history && state.history.chats) || [];
  const byId = useMemo(() => new Map(state.sessions.map(s => [s.session, s])), [state.sessions]);
  const visible = iv => (iv.end == null ? now : iv.end) > t0 && iv.start < now;
  // Newest activity first, so the rows line up with "now" on the left; by default only chats that did something
  // in the visible stretch, the rest of the window behind a button.
  const { chatRows, more } = useMemo(() => {
    const last = new Map();
    for (const c of chats) if (visible(c)) last.set(c.session, Math.max(last.get(c.session) || 0, c.end == null ? now : c.end));
    const all = [...last.keys()].sort((a, b) => last.get(b) - last.get(a)).slice(0, 25);
    const inView = all.filter(sid => last.get(sid) > now - zoom);
    return { chatRows: allChats ? all : inView, more: all.length - inView.length };
  }, [chats, Math.floor(now / 10000), span, zoom, allChats, byId]);
  const minor = zoom <= 3600e3 ? 10 * 60e3 : zoom <= 2 * 3600e3 ? 15 * 60e3 : 30 * 60e3, major = minor * 2;
  const ticks = [];
  for (let v = Math.floor(now / minor) * minor; v >= t0; v -= minor) ticks.push(v);
  const RH = 30, CH = 26, HEAD = 26, GAP = 28;
  const yRes = i => HEAD + i * RH, yChatsHead = HEAD + resources.length * RH + 4, yChat = i => yChatsHead + GAP - 4 + i * CH;
  const H = (chatRows.length ? yChat(chatRows.length) : yChatsHead) + 6;
  const tip = (e, lines) => setTip({ x: e.clientX + 14, y: e.clientY + 12, lines });
  const maxChars = Math.floor((LW - 24) / 6.6);
  const bar = (a, b) => { const x = X(b), w = Math.max(3, X(a) - x); return { x, w }; };
  const when = iv => `${hm(iv.start)} – ${iv.end == null ? t('tl.now') : hm(iv.end)} · ${human((iv.end == null ? now : iv.end) - iv.start)}`;
  const KIND = { working: [t('state.working'), null], background: [t('state.background'), 'var(--mantine-color-cyan-5)'], owner: [t('state.needs-owner'), 'var(--mantine-color-orange-6)'] };

  return (
    <Paper withBorder radius="md" p="xs">
      <Group justify="space-between" px="xs" pb={6} gap="xs">
        <Text size="xs" c="dimmed">{t('tl.hint', { d: human(span) })}</Text>
        <Group gap={6}>
          <Text size="xs" c="dimmed">{t('tl.inView')}</Text>
          <SegmentedControl size="xs" value={String(zoom)} onChange={v => { setZoom(Number(v)); store.set('hub.zoom', Number(v)); }}
            data={ZOOMS.map(h => ({ label: t('tl.hours', { n: h }), value: String(h * 3600e3) }))} />
        </Group>
      </Group>
      <div ref={ref} style={{ display: 'flex' }}>
        <svg className="board-svg" width={LW} height={H} style={{ flex: 'none', display: 'block' }}>
          {resources.map((r, i) => (
            <g key={r.key}>
              <circle cx="10" cy={yRes(i) + RH / 2} r="4.5" fill={resColor(r)} />
              <text className="lab" x="22" y={yRes(i) + RH / 2 + 4}><title>{r.key}</title>{clip(r.label, maxChars)}</text>
            </g>
          ))}
          {chatRows.length ? <text className="grp" x="2" y={yChatsHead + 14}>{t('tl.chats').toUpperCase()}</text> : null}
          {chatRows.map((sid, i) => {
            const s = byId.get(sid), ivs = chats.filter(c => c.session === sid);
            const title = (s && s.title) || (ivs[0] && ivs[0].title) || sid.slice(0, 8);
            return (
              <g key={sid}>
                <circle cx="10" cy={yChat(i) + CH / 2} r="4" fill={`var(--mantine-color-${STATE_COLOR[s ? viewState(s) : ''] || 'gray'}-6)`} />
                <text className="lab" x="22" y={yChat(i) + CH / 2 + 4} style={{ fill: s && isClosed(s) ? 'var(--mantine-color-dimmed)' : undefined }}><title>{title}</title>{clip(title, maxChars)}</text>
              </g>
            );
          })}
        </svg>
        <div style={{ overflowX: 'auto', flex: 1, minWidth: 0 }}>
          <svg className="board-svg" width={total} height={H} style={{ display: 'block' }}>
            <defs>
              <pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--mantine-color-orange-6)" strokeWidth="2.5" />
              </pattern>
            </defs>
            {ticks.map(v => {
              const isMajor = v % major === 0;
              return (
                <g key={v}>
                  <line x1={X(v)} x2={X(v)} y1={HEAD - 6} y2={H - 4} stroke="var(--mantine-color-default-border)" strokeDasharray={isMajor ? undefined : '2 4'} />
                  {isMajor && X(v) > 100 ? <text x={X(v)} y="14" textAnchor="middle">{hm(v)}</text> : null}
                </g>
              );
            })}
            <line x1="1" x2="1" y1={HEAD - 6} y2={H - 4} stroke="var(--mantine-primary-color-filled)" strokeWidth="2" />
            <text x="4" y="14" style={{ fill: 'var(--mantine-primary-color-filled)', fontWeight: 700 }}>{t('tl.nowAt', { time: hm(now) })}</text>
            {resources.map((r, i) => {
              const y = yRes(i), ivs = locks.filter(iv => iv.res === r.key && visible(iv));
              return (
                <g key={r.key}>
                  <rect x="0" y={y + 3} width={total} height={RH - 6} rx="5" fill="var(--mantine-color-default-hover)" />
                  {ivs.map((iv, k) => {
                    const who = iv.chat || iv.script;
                    if (EVENT_KINDS.includes(iv.kind)) {
                      const fill = iv.kind === 'grant' || iv.kind === 'return' ? 'var(--mantine-color-green-6)' : 'var(--mantine-color-yellow-6)';
                      return <circle key={k} className="hit" cx={X(iv.start)} cy={y + RH / 2} r="4.5" fill={fill} stroke="var(--mantine-color-body)" strokeWidth="1.5"
                        onMouseMove={e => tip(e, [t('tl.' + iv.kind) + ': ' + who, hm(iv.start)])} onMouseLeave={() => setTip(null)} />;
                    }
                    const { x, w } = bar(iv.start, iv.end == null ? now : iv.end);
                    const lines = [(iv.kind === 'hold' ? t('tl.holds') : t('tl.waits')) + ': ' + who, (iv.script || '') + (iv.note ? ' · ' + iv.note : ''), when(iv)];
                    return iv.kind === 'hold'
                      ? <rect key={k} className="hit" x={x} y={y + 5} width={w} height={RH - 10} rx="4" fill={iv.mode === 'presence' ? 'var(--mantine-color-yellow-6)' : resColor(r)}
                        opacity={iv.end == null ? 1 : 0.8} onMouseMove={e => tip(e, lines)} onMouseLeave={() => setTip(null)} />
                      : <rect key={k} className="hit" x={x} y={y + RH - 9} width={w} height="5" rx="2" fill="url(#hatch)" onMouseMove={e => tip(e, lines)} onMouseLeave={() => setTip(null)} />;
                  })}
                </g>
              );
            })}
            {chatRows.map((sid, i) => {
              const y = yChat(i), s = byId.get(sid), ivs = chats.filter(c => c.session === sid && visible(c));
              const title = (s && s.title) || (ivs[0] && ivs[0].title) || sid.slice(0, 8);
              return (
                <g key={sid}>
                  <line x1="0" x2={total} y1={y + CH / 2} y2={y + CH / 2} stroke="var(--mantine-color-default-border)" />
                  {ivs.map((iv, k) => {
                    const { x, w } = bar(iv.start, iv.end == null ? now : iv.end), [label, fill] = KIND[iv.kind] || KIND.working;
                    const thin = iv.kind === 'background';
                    return <rect key={k} className="hit" x={x} y={y + (thin ? 9 : 5)} width={w} height={thin ? CH - 18 : CH - 10} rx="3"
                      fill={fill || chatColor(sid, 0.9)} onMouseMove={e => tip(e, [title, label, when(iv)])} onMouseLeave={() => setTip(null)} />;
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      {more > 0 ? (
        <Button size="compact-xs" variant="subtle" mx="xs" mt={4} onClick={() => setAllChats(!allChats)}>
          {allChats ? t('tl.onlyInView') : t('tl.moreChats', { n: more })}
        </Button>
      ) : null}
      <Group gap="lg" px="xs" pt={6} pb={2}>
        {[
          [t('legend.holdRes'), resColor(resources[0])],
          [t('legend.wait'), 'repeating-linear-gradient(45deg, var(--mantine-color-orange-6) 0 2px, transparent 2px 5px)'],
          [t('legend.person'), 'var(--mantine-color-yellow-6)'],
          [t('legend.workingColor'), chatColor('x', 0.9)],
          [t('legend.background'), 'var(--mantine-color-cyan-5)'],
          [t('legend.owner'), 'var(--mantine-color-orange-6)'],
        ].map(([l, bg]) => (
          <Group key={l} gap={6}><span style={{ width: 14, height: 8, borderRadius: 2, background: bg }} /><Text size="xs" c="dimmed">{l}</Text></Group>
        ))}
        <Group gap={6}><span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--mantine-color-yellow-6)' }} /><Text size="xs" c="dimmed">{t('tl.ask')} / {t('tl.decline')}</Text></Group>
        <Group gap={6}><span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--mantine-color-green-6)' }} /><Text size="xs" c="dimmed">{t('tl.grant')} / {t('tl.return')}</Text></Group>
      </Group>
    </Paper>
  );
}
