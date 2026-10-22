import { useEffect, useRef } from 'react';
import { useElementSize } from '@mantine/hooks';
import { Button, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCircleCheck, IconUser } from '@tabler/icons-react';
import { t } from './i18n.js';
import { hm, human, machineLabel } from './util.js';

export function noticeText(state, n) {
  const node = (state.nodes || []).find(x => x.key === n.key);
  return t('notice.return', { machine: node ? node.label : n.key, who: n.who || '' });
}

// Handover requests: a run from another machine asks for a machine a person is using ("Yes, take it" / "Not now"),
// and for 15 minutes after a granted run ends, "X has finished - the machine is yours again".
export default function Asks({ state, now, act }) {
  // In a narrow container (a side pane) the buttons go in a row under the text, never beside it.
  const { ref, width } = useElementSize();
  const compact = width > 0 && width < 900;
  const asks = (state.asks || []).filter(a => a.state === 'pending' || a.state === 'declined');
  const notices = (state.notices || []).filter(n => n.kind === 'return' && now - n.t < 15 * 60e3);
  if (!asks.length && !notices.length) return null;
  return (
    <Stack gap="sm" mb="lg" ref={ref}>
      {asks.map(a => {
        const node = (state.nodes || []).find(n => n.key === a.key);
        const machine = node ? node.label : a.label || a.key;
        const what = a.note || a.command || a.script || '';
        const again = a.state === 'declined' ? a.declinedAt + state.handover.askAgainMin * 60e3 : 0;
        const g = node && node.probe && node.probe.gpu;
        return (
          <Paper key={a.key + a.token} withBorder p="md" radius="md" className="ask-banner">
            <Group justify="space-between" align="flex-start" gap="sm" wrap={compact ? 'wrap' : 'nowrap'}>
              <Group wrap="nowrap" align="flex-start" gap="md" style={{ minWidth: 0, flex: compact ? '1 1 100%' : '1 1 auto' }}>
                <ThemeIcon size={38} radius="xl" variant="light" color="yellow" style={{ flex: 'none' }}><IconUser size={20} /></ThemeIcon>
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Text fw={700} className="clamp2" lh={1.35}>{t('ask.title', { from: machineLabel(state, a.machine), machine, who: a.chat || a.script || '' })}</Text>
                  <Text size="sm" c="dimmed" className={compact ? 'clamp1' : undefined} title={what}>{what ? what + ' · ' : ''}{t('ask.waiting', { d: human(now - a.since) })}{a.blockedBy ? ' · ' + a.blockedBy : ''}</Text>
                  {g ? <Text size="sm" c="dimmed" className="clamp1">{t('ask.gpu', { used: g.usedMB, total: g.totalMB })}</Text> : null}
                  {a.state === 'declined' ? <Text size="sm" c="orange">{t('ask.declined', { time: hm(again) })}</Text> : null}
                </Stack>
              </Group>
              <Group gap="xs" wrap="nowrap" justify="flex-end" style={compact ? { flex: '1 1 100%' } : { flex: 'none' }}>
                <Button color="green" onClick={() => act('grant', { key: a.key, token: a.token })}>{t('ask.yes')}</Button>
                {a.state === 'pending' ? <Button variant="default" onClick={() => act('decline', { key: a.key, token: a.token })}>{t('ask.no')}</Button> : null}
              </Group>
            </Group>
          </Paper>
        );
      })}
      {notices.map(n => (
        <Paper key={n.t + n.key} withBorder p="sm" radius="md">
          <Group justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap"><IconCircleCheck size={18} color="var(--mantine-color-green-6)" /><Text size="sm">{noticeText(state, n)}</Text></Group>
            <Text size="xs" c="dimmed">{hm(n.t)}</Text>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.06;
    o.start(); o.stop(ctx.currentTime + 0.18);
  } catch (_) {}
}

// A beep and (with permission) a browser notification for a handover request or a "yours again" notice that
// appears while the page is open; the state found on load does not ring.
export function useAskAlerts(state) {
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
          try {
            new Notification(state.name, { body: a ? t('ask.title', { from: machineLabel(state, a.machine), machine: a.label || a.key, who: a.chat || a.script || '' }) : n ? noticeText(state, n) : '' });
          } catch (_) {}
        }
      }
    }
    seen.current = keys;
  }, [state]);
}
