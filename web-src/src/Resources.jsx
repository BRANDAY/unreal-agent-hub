import { Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text, ThemeIcon, Title, Tooltip } from '@mantine/core';
import {
  IconBox, IconCode, IconCpu, IconDeviceDesktop, IconDeviceLaptop, IconExternalLink, IconFlame, IconHourglass, IconPackage, IconUser,
} from '@tabler/icons-react';
import { t } from './i18n.js';
import { ago, chatColor, dur, hm, human, modeText, resColorName, stateText, whoOf } from './util.js';

const ICON = { editor: IconDeviceDesktop, cpp: IconCode, cook: IconPackage, smoke: IconFlame, machine: IconDeviceLaptop, gpu: IconCpu, box: IconBox, person: IconUser };
export const iconOf = r => ICON[r.icon] || ICON[r.id] || (r.node ? IconDeviceLaptop : IconBox);
const AGENT_COLOR = { claude: 'orange', codex: 'teal', cursor: 'violet' };

export function AgentBadge({ agent }) {
  if (!agent) return null;
  return <Badge size="xs" variant="outline" color={AGENT_COLOR[agent] || 'gray'} style={{ flex: 'none' }}>{agent}</Badge>;
}

export function OpenButton({ host, act, compact }) {
  if (!host || !host.startsWith('local_')) return null;
  return (
    <Tooltip label={t('chat.openTitle')} withArrow>
      <Button size="compact-xs" variant="light" leftSection={<IconExternalLink size={12} />}
        onClick={e => { e.stopPropagation(); act('open', { hostSession: host }); }}>
        {compact ? null : t('chat.open')}
      </Button>
    </Tooltip>
  );
}

// A busy resource is the whole card in its colour (a stripe on grey did not catch the eye); a free one stays
// neutral. `color`: a Mantine colour name or, from the config, any CSS colour.
const MANTINE_NAME = /^[a-z]+$/;
const tint = color => {
  if (!color) return { opacity: 0.85 };
  if (MANTINE_NAME.test(color)) return { background: `var(--mantine-color-${color}-light)`, borderColor: `var(--mantine-color-${color}-filled)`, boxShadow: `inset 0 3px 0 var(--mantine-color-${color}-filled)` };
  return { background: `color-mix(in srgb, ${color} 14%, var(--mantine-color-body))`, borderColor: color, boxShadow: `inset 0 3px 0 ${color}` };
};

function Who({ name, children }) {
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, flex: 'none', background: chatColor(name) }} />
      <Text size="sm" fw={600} className="clamp1" title={name}>{name}</Text>
      {children}
    </Group>
  );
}

function Queue({ waiters, now }) {
  if (!waiters.length) return null;
  return (
    <Stack gap={2} mt="xs" pt="xs" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
      {waiters.map(w => (
        <Group key={w.token} justify="space-between" wrap="nowrap" gap="xs">
          <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
            <IconHourglass size={13} color="var(--mantine-color-orange-6)" style={{ flex: 'none' }} />
            <Text size="xs" className="clamp1" title={w.note || w.script}>{w.chat || w.script || w.mode}{w.blocked ? ' · ' + t('queue.forPerson') : ''}</Text>
            <Tooltip label={t('queue.priority')}><Badge size="xs" variant="light" color="gray">{w.priority}</Badge></Tooltip>
          </Group>
          <Text size="xs" c="dimmed" ff="monospace">{dur(now - w.since)}</Text>
        </Group>
      ))}
    </Stack>
  );
}

function ResourceCard({ r, now, history, act, hostOf }) {
  const l = r.lock;
  const person = l && !l.stale && l.mode === 'presence';
  const color = resColorName(r) || 'indigo';
  const Icon = iconOf(r);
  const pill = !l ? ['gray', t('pill.free')] : l.stale ? ['red', t('pill.stale')] : person ? ['yellow', t('pill.person')] : [color, t('pill.busy')];
  let body;
  if (!l) {
    const last = (history || []).filter(iv => iv.res === r.key && iv.kind === 'hold' && iv.end != null).sort((a, b) => b.end - a.end)[0];
    body = last ? (
      <Stack gap={2}>
        <Text size="xs" c="dimmed">{t('res.lastHeld')}</Text>
        <Who name={last.chat || last.script} />
        <Text size="xs" c="dimmed">{human(last.end - last.start)} · {t('res.freed', { ago: ago(last.end) })}</Text>
      </Stack>
    ) : <Text size="sm" c="dimmed">{t('res.notUsed')}</Text>;
  } else if (l.unreadable) {
    body = <Text size="sm" c="red">{t('res.unreadable')}</Text>;
  } else {
    const since = l.since, until = l.expires || since, frac = until > since ? Math.min(1, (now - since) / (until - since)) : 0;
    const host = l.hostSession || hostOf(l.session);
    body = (
      <Stack gap={4}>
        <Group justify="space-between" wrap="nowrap">
          <Who name={whoOf(l)}><AgentBadge agent={l.agent} /></Who>
          <OpenButton host={host} act={act} compact />
        </Group>
        <Text size="xs" c="dimmed" className="clamp1" title={`${l.script || ''} ${l.note || ''}`}>
          {modeText(l.mode)}{l.mode === 'script' && l.script ? ' · ' + l.script : ''}{l.note ? ' · ' + l.note : ''}{l.machine ? ' · ' + l.machine : ''}
        </Text>
        <Text fz={26} fw={700} ff="monospace" lh={1.1}>{dur(now - since)}</Text>
        {until > since ? (
          <Tooltip label={t('res.ttlUntil', { time: hm(until) })}>
            <Progress value={frac * 100} color={frac > 0.85 ? 'orange' : person ? 'yellow' : color} size="sm" />
          </Tooltip>
        ) : null}
        <Text size="xs" c="dimmed">
          {t('res.since', { time: hm(since) })}{until > since ? ' · ' + t('res.ttlUntil', { time: hm(until) }) : ''}{l.stale ? ' · ' + t('res.staleWhy', { why: l.stale }) : ''}
        </Text>
        {l.stale ? (
          <Button size="xs" color="red" variant="light" mt={4} onClick={() => {
            if (confirm(t('res.breakConfirm', { name: r.label, who: whoOf(l), why: l.stale }))) act('break', { key: r.key, token: l.token });
          }}>{t('res.break')}</Button>
        ) : null}
      </Stack>
    );
  }
  return (
    <Card withBorder padding="md" style={tint(!l ? '' : person ? 'yellow' : l.stale ? 'red' : resColorName(r) || r.color)}>
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon variant="light" color={color} size="md"><Icon size={16} /></ThemeIcon>
          <Text fw={600} size="sm" className="clamp1" title={r.key}>{r.label}</Text>
        </Group>
        <Badge color={pill[0]} variant={l ? 'filled' : 'light'} size="sm" style={{ flex: 'none' }}>{pill[1]}</Badge>
      </Group>
      {body}
      <Queue waiters={r.waiters} now={now} />
    </Card>
  );
}

export function NodeCard({ n, r, now, act }) {
  const p = n.probe || {}, lock = r && r.lock && !r.lock.stale ? r.lock : null;
  const online = p.online !== false && !!p.at;
  const graceLeft = !p.busy && p.lastBusyAt && n.graceMin ? n.graceMin * 60e3 - (now - p.lastBusyAt) : 0;
  const busy = p.busy || graceLeft > 0 || !!lock;
  const pill = !p.at ? ['gray', t('node.noProbe')] : !online ? ['red', t('node.offline')] : n.presence ? ['yellow', t('pill.person')] : busy ? ['teal', t('pill.busy')] : ['green', t('pill.free')];
  const g = p.gpu, gf = g && g.totalMB ? g.usedMB / g.totalMB : 0;
  const fill = n.presence ? 'yellow' : !online && p.at ? 'red' : busy ? (r ? resColorName(r) || r.color : 'teal') : '';
  const link = n.transport === 'ssh-reverse' ? (n.tunnel.up ? t('node.tunnelUp') : t('node.tunnelDown') + (n.tunnel.error ? ': ' + n.tunnel.error : '')) : n.transport;
  return (
    <Card withBorder padding="md" style={tint(fill)}>
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <ThemeIcon variant="light" color="teal" size="md"><IconDeviceLaptop size={16} /></ThemeIcon>
          <Text fw={600} size="sm">{n.label}</Text>
        </Group>
        <Badge color={pill[0]} variant={busy || n.presence ? 'filled' : 'light'} size="sm">{pill[1]}</Badge>
      </Group>
      <Stack gap={4}>
        {n.detail || (n.roles || []).length ? <Text size="xs" c="dimmed">{[n.detail, (n.roles || []).map(x => t('role.' + x)).join(', ')].filter(Boolean).join(' · ')}</Text> : null}
        {lock ? (<>
          <Who name={whoOf(lock)}><AgentBadge agent={lock.agent} /></Who>
          <Text size="xs" c="dimmed">{modeText(lock.mode)}{lock.note ? ' · ' + lock.note : ''} · {dur(now - lock.since)}</Text>
        </>) : null}
        {(p.desktop || []).length ? p.desktop.map(d => (
          <Group key={d.pid} justify="space-between" wrap="nowrap">
            <Text size="xs" c="teal" className="clamp1">▶ {d.name.replace(/\.exe$/i, '')}{d.project ? ' · ' + d.project : ''}</Text>
            <Text size="xs" c="dimmed">{d.since ? t('res.since', { time: hm(d.since) }) : d.memMB + ' MB'}</Text>
          </Group>
        )) : online && p.at ? (
          <Text size="xs" c="dimmed">{graceLeft > 0 ? t('node.grace', { ago: ago(p.lastBusyAt), left: human(graceLeft) }) : t('node.idle')}</Text>
        ) : null}
        {p.load && p.load.busy ? <Text size="xs" c="teal">{t('node.load')}: {(p.load.why || []).join('; ')}</Text> : null}
        {g ? (<>
          <Text size="xs" c="dimmed" mt={4}>{t('node.gpu', { used: g.usedMB, total: g.totalMB, util: g.util })}</Text>
          <Progress value={gf * 100} color={gf > 0.8 ? 'orange' : 'teal'} size="sm" />
        </>) : null}
        {n.chats.length ? (
          <Stack gap={2} mt="xs" pt="xs" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
            {n.chats.map(c => (
              <Group key={c.session} justify="space-between" wrap="nowrap" title={c.lastPrompt || ''}>
                <Text size="xs" className="clamp1">{c.title || c.project}{c.title && c.project ? ' · ' + c.project : ''}</Text>
                <Badge size="xs" variant="dot" style={{ flex: 'none' }}>{stateText(c.state)}</Badge>
              </Group>
            ))}
          </Stack>
        ) : null}
        <Text size="xs" c="dimmed" mt={4} title={n.tunnel.error || ''}>
          {p.at ? t('node.probedAt', { time: hm(p.fetched || p.at) }) : t('node.neverProbed')} · {link}
          {n.insecure ? <Text span size="xs" c="orange"> · {t('node.noToken')}</Text> : null}
        </Text>
        <Group gap="xs" mt={4}>
          <Button size="xs" variant="default" loading={!!n.probing} onClick={() => act('node/probe', { node: n.id })}>{n.probing ? t('node.checking') : t('node.check')}</Button>
          {n.presence
            ? <Button size="xs" variant="light" color="yellow" onClick={() => act('presence', { node: n.id, on: false })}>{t('node.left', { m: n.label })}</Button>
            : <Tooltip label={t('node.hereTitle')} multiline w={280}><Button size="xs" variant="default" onClick={() => act('presence', { node: n.id, on: true })}>{t('node.here', { m: n.label })}</Button></Tooltip>}
        </Group>
      </Stack>
    </Card>
  );
}

/** Resource cards grouped by "<hub> (this machine)" and by project; node resources go to the Machines section. */
export default function Resources({ state, now, act, hostOf }) {
  const nodeKeys = new Set((state.nodes || []).map(n => n.key));
  const groups = [];
  for (const r of state.resources.filter(x => !nodeKeys.has(x.key))) {
    const name = r.scope === 'project' ? r.projectLabel || r.project : t('res.machineGroup', { m: state.hub.label });
    let g = groups.find(x => x.name === name);
    if (!g) { g = { name, list: [] }; groups.push(g); }
    g.list.push(r);
  }
  if (!groups.length) return <Text size="sm" c="dimmed">{t('res.none')}</Text>;
  return (
    <Stack gap="md">
      {groups.map(g => (
        <Stack key={g.name} gap="xs">
          {groups.length > 1 || g.list[0].scope === 'project' ? <Title order={4} fz="sm" c="dimmed" tt="uppercase" lts={0.5}>{g.name}</Title> : null}
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4, xl: 5 }} spacing="md">
            {g.list.map(r => <ResourceCard key={r.key} r={r} now={now} history={state.history && state.history.locks} act={act} hostOf={hostOf} />)}
          </SimpleGrid>
        </Stack>
      ))}
    </Stack>
  );
}

export function Machines({ state, now, act }) {
  return (
    <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }} spacing="md">
      {state.nodes.map(n => <NodeCard key={n.id} n={n} r={state.resources.find(r => r.key === n.key)} now={now} act={act} />)}
    </SimpleGrid>
  );
}
