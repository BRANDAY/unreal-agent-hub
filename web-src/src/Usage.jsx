import { useState } from 'react';
import { Anchor, Badge, Grid, Group, Paper, SegmentedControl, SimpleGrid, Stack, Table, Text, Tooltip } from '@mantine/core';
import { BarChart } from '@mantine/charts';
import { useElementSize } from '@mantine/hooks';
import { OpenButton } from './Resources.jsx';
import { LANG, t, tm } from './i18n.js';
import { hm, store } from './util.js';

// What the tokens of the Claude Code chats would cost at API prices. Subscription users do not pay this: it is
// "what the work would have cost". The hub counts it from the Claude Code journals (state.usage, lib/usage.cjs).
const fmt = x => '$' + (x >= 1000 ? Math.round(x).toLocaleString(LANG) : x >= 100 ? Math.round(x) : x.toFixed(2));
const day = d => new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const shortDate = d => (d ? day(d).toLocaleDateString(LANG, { day: '2-digit', month: '2-digit' }) : '—');
const iso = x => new Date(x - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 10);

function Stat({ label, value, sub, accent }) {
  return (
    <Paper withBorder radius="md" p="md" style={accent ? { background: 'var(--mantine-color-teal-light)', borderColor: 'var(--mantine-color-teal-filled)' } : undefined}>
      <Text fz={28} fw={700} lh={1}>{value}</Text>
      <Text size="xs" c="dimmed" mt={6}>{label}</Text>
      {sub ? <Text size="xs" c="dimmed">{sub}</Text> : null}
    </Paper>
  );
}

function MachineBadges({ u, now }) {
  return (
    <Group gap="xs">
      {Object.entries(u.machines || {}).map(([id, m]) => {
        const name = m.label || id;
        const color = m.ok ? (now - m.at < 30 * 60e3 ? 'teal' : 'yellow') : 'gray';
        const text = m.ok ? t('us.m.ok', { name, time: hm(m.at) }) : t(m.at ? 'us.m.noAnswer' : 'us.m.notAsked', { name });
        return (
          <Tooltip key={id} label={m.error || (m.ok ? t('us.m.tipOk') : t('us.m.tipMissing'))} withArrow multiline w={260}>
            <Badge variant="light" color={color} size="sm">{text}</Badge>
          </Tooltip>
        );
      })}
    </Group>
  );
}

/** The KPI tile of the top row, or null when there is nothing to show (feature off, not counted yet, error). */
export function usageKpi(u) {
  if (!u || u.error || typeof u.today !== 'number') return null;
  return { value: fmt(u.today), label: t('kpi.usage', { total: fmt(u.total) }) };
}

export default function Usage({ state, act, now }) {
  const u = state.usage;
  const { ref, width } = useElementSize();
  const [mode, setMode] = useState(() => store.get('uah.usageMode', 'today'));
  if (u === undefined) return null;
  if (!u) return <Text size="sm" c="dimmed">{t('us.counting')}</Text>;
  if (u.error) return <Text size="sm" c="red">{tm(u.error)}</Text>;
  const days = u.days || [];
  const dayUsd = d => (days.find(x => x.date === d) || { usd: 0 }).usd;
  const yesterday = dayUsd(iso(now - 86400e3));
  const last7 = days.filter(d => d.date > iso(now - 7 * 86400e3)).reduce((s, d) => s + d.usd, 0);
  const last30 = days.slice(-30);
  const perDay = days.length ? u.total / days.length : 0;
  const rows = (mode === 'today' ? u.chatsToday : u.chats) || [];
  const narrow = width > 0 && width < 700;
  const machines = Object.entries(u.machines || {});
  const missing = machines.filter(([, m]) => !m.ok).map(([id, m]) => m.label || id);
  const models = (u.models || []).slice(0, 4).map(m => `${m.model.replace('claude-', '')} ${fmt(m.usd)}`).join(', ');
  const prices = u.prices || {};
  return (
    <Stack gap="md" ref={ref}>
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="md">
        <Stat label={t('us.today')} value={fmt(u.today)} accent />
        <Stat label={t('us.yesterday')} value={fmt(yesterday)} />
        <Stat label={t('us.last7')} value={fmt(last7)} />
        <Stat label={t('us.totalSince', { date: shortDate(u.since) })} value={fmt(u.total)} sub={t('us.responses', { n: (u.responses || 0).toLocaleString(LANG) })} />
        <Stat label={t('us.perDay')} value={fmt(perDay)} sub={t('us.days', { n: days.length })} />
      </SimpleGrid>
      <Grid gutter="md">
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Paper withBorder radius="md" p="md" h="100%">
            <Group justify="space-between" mb="sm"><Text fw={600}>{t('us.byDay')}</Text><Text size="xs" c="dimmed">{t('us.lastDays', { n: last30.length })}</Text></Group>
            <BarChart h={220} data={last30.map(d => ({ day: shortDate(d.date), usd: d.usd }))} dataKey="day"
              series={[{ name: 'usd', color: 'teal.6', label: '$' }]} tickLine="none" gridAxis="y" yAxisProps={{ width: 48 }}
              valueFormatter={v => fmt(v)} barProps={{ radius: 3 }} />
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Paper withBorder radius="md" p="md" h="100%">
            <Group justify="space-between" mb="sm" gap="xs">
              <Text fw={600}>{t('us.byChat')}</Text>
              <SegmentedControl size="xs" value={mode} onChange={v => { setMode(v); store.set('uah.usageMode', v); }}
                data={[{ value: 'today', label: t('us.modeToday') }, { value: 'all', label: t('us.modeAll') }]} />
            </Group>
            {rows.length ? (
              <Table.ScrollContainer minWidth={0} mah={260}>
                <Table verticalSpacing={4} highlightOnHover>
                  <Table.Tbody>
                    {rows.slice(0, 15).map(r => (
                      <Table.Tr key={r.sid}>
                        <Table.Td style={{ maxWidth: 0, width: '100%' }}>
                          <Text size="sm" className="clamp1" title={r.title || r.name || r.sid}>{r.title || r.name || t('us.session', { id: String(r.sid).slice(0, 8) })}</Text>
                          {narrow ? null : <Text size="xs" c="dimmed">{mode === 'today' ? t('us.chatTotal', { sum: fmt(r.usd) }) : t('us.lastSeen', { date: shortDate(r.last) })}</Text>}
                        </Table.Td>
                        <Table.Td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}><Text size="sm" fw={700} ff="monospace">{fmt(mode === 'today' ? r.today : r.usd)}</Text></Table.Td>
                        <Table.Td style={{ width: 36 }}><OpenButton host={r.hostSession} act={act} compact /></Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            ) : <Text size="sm" c="dimmed">{t(mode === 'today' ? 'us.noChatsToday' : 'us.noChats')}</Text>}
          </Paper>
        </Grid.Col>
      </Grid>
      <Group justify="space-between" gap="xs" align="flex-start">
        <Stack gap={4} style={{ flex: '1 1 420px' }}>
          <Text size="xs" c="dimmed">
            {t('us.note')}
            {prices.read ? <> {t('us.prices', { date: day(prices.read).toLocaleDateString(LANG) })}{' '}{/^https?:\/\//.test(prices.source || '') ? <Anchor size="xs" href={prices.source} target="_blank" rel="noopener noreferrer">{prices.source}</Anchor> : prices.source}</> : null}
            {models ? ' ' + t('us.models', { list: models }) : ''}
            {missing.length ? ' ' + t('us.missing', { names: missing.join(', ') }) : ''}
          </Text>
          {(u.unpriced || []).length ? <Text size="xs" c="orange">{t('us.unpriced', { list: u.unpriced.join(', ') })}</Text> : null}
        </Stack>
        <MachineBadges u={u} now={now} />
      </Group>
    </Stack>
  );
}
