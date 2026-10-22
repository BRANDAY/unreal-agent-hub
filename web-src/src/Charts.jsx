import { useMemo } from 'react';
import { Group, Paper, Progress, Stack, Text, Tooltip } from '@mantine/core';
import { BarChart, DonutChart } from '@mantine/charts';
import { t } from './i18n.js';
import { STATE_COLOR, hm, human, resColorName, stateText, viewState } from './util.js';

function Panel({ title, sub, children }) {
  return (
    <Paper withBorder radius="md" p="md" h="100%">
      <Group justify="space-between" align="baseline" mb="sm" gap="xs">
        <Text fw={600}>{title}</Text>
        {sub ? <Text size="xs" c="dimmed">{sub}</Text> : null}
      </Group>
      {children}
    </Paper>
  );
}

// Who spent the window how: per chat, the time of its turns, of background work after the turn, and of waiting for
// a person. Busiest first; bar lengths are relative to the busiest chat.
export function ChatTime({ state, now, win }) {
  const t0 = now - win, chats = (state.history && state.history.chats) || [];
  const rows = useMemo(() => {
    const by = new Map();
    for (const c of chats) {
      const a = Math.max(t0, c.start), b = Math.min(now, c.end == null ? now : c.end);
      if (b <= a) continue;
      const r = by.get(c.session) || { session: c.session, title: c.title || '', working: 0, background: 0, owner: 0, turns: 0 };
      r[c.kind] = (r[c.kind] || 0) + (b - a);
      if (c.kind === 'working') r.turns++;
      by.set(c.session, r);
    }
    const sessions = new Map(state.sessions.map(s => [s.session, s]));
    return [...by.values()].map(r => Object.assign(r, { s: sessions.get(r.session), total: r.working + r.background + r.owner }))
      .sort((a, b) => b.total - a.total).slice(0, 10);
  }, [chats, Math.floor(now / 30000), win, state.sessions]);
  const max = Math.max(1, ...rows.map(r => r.total));
  return (
    <Panel title={t('chart.chatTime')} sub={t('chart.chatTimeSub')}>
      {rows.length ? <Stack gap={10}>
        {rows.map(r => {
          const title = (r.s && r.s.title) || r.title || r.session.slice(0, 8);
          return (
            <div key={r.session}>
              <Group justify="space-between" gap="xs" wrap="nowrap" mb={3}>
                <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, flex: 'none', background: `var(--mantine-color-${STATE_COLOR[r.s ? viewState(r.s) : ''] || 'gray'}-6)` }} />
                  <Text size="sm" className="clamp1" title={title}>{title}</Text>
                </Group>
                <Text size="sm" fw={700} style={{ flex: 'none' }}>{human(r.working)}</Text>
              </Group>
              <Tooltip label={t('chart.chatTimeTip', { w: human(r.working), n: r.turns, b: human(r.background), o: human(r.owner) })}>
                <Progress.Root size="md">
                  <Progress.Section value={r.working / max * 100} color="green" />
                  <Progress.Section value={r.background / max * 100} color="cyan" />
                  <Progress.Section value={r.owner / max * 100} color="orange" />
                </Progress.Root>
              </Tooltip>
            </div>
          );
        })}
      </Stack> : <Text size="sm" c="dimmed">{t('chart.chatTimeNone')}</Text>}
    </Panel>
  );
}

// Share of the window each resource was held, how often it was taken, and how long its queue waited.
export function Load({ state, now, win }) {
  const t0 = now - win, locks = (state.history && state.history.locks) || [];
  const part = iv => Math.max(0, Math.min(now, iv.end == null ? now : iv.end) - Math.max(t0, iv.start));
  if (!state.resources.length) return <Panel title={t('h.load')}><Text size="sm" c="dimmed">{t('res.none')}</Text></Panel>;
  return (
    <Panel title={t('h.load')} sub={t('chart.loadSub')}>
      <Stack gap="sm">
        {state.resources.map(r => {
          const h = locks.filter(iv => iv.res === r.key && iv.kind === 'hold'), w = locks.filter(iv => iv.res === r.key && iv.kind === 'wait');
          const busy = Math.min(win, h.reduce((s, iv) => s + part(iv), 0)), wait = w.reduce((s, iv) => s + part(iv), 0);
          const takes = h.filter(iv => iv.start >= t0).length, pct = Math.round(busy / win * 100);
          return (
            <div key={r.key}>
              <Group justify="space-between" mb={4} wrap="nowrap">
                <Text size="sm" className="clamp1" title={r.key}>{r.label}</Text>
                <Text size="xs" c="dimmed" style={{ flex: 'none' }}>{t('load.row', { pct, n: takes, wait: human(wait) })}</Text>
              </Group>
              <Tooltip label={t('chart.loadTip', { busy: human(busy), wait: human(wait) })}>
                <Progress.Root size="lg">
                  <Progress.Section value={pct} color={resColorName(r) || r.color} />
                  {wait > 0 ? <Progress.Section value={Math.min(100 - pct, wait / win * 100)} color="orange" striped /> : null}
                </Progress.Root>
              </Tooltip>
            </div>
          );
        })}
      </Stack>
    </Panel>
  );
}

// Chats by state right now (closed long ago left out).
export function States({ state }) {
  const data = useMemo(() => {
    const c = {};
    for (const s of state.sessions) if (!s.old) { const v = viewState(s); c[v] = (c[v] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: stateText(k), value: v, color: (STATE_COLOR[k] || 'gray') + '.6' }));
  }, [state.sessions]);
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <Panel title={t('chart.states')} sub={t('chart.statesSub', { n: total })}>
      {total ? (
        <Group justify="center" wrap="nowrap" gap="lg">
          <DonutChart data={data} size={170} thickness={24} withLabelsLine={false} chartLabel={total} tooltipDataSource="segment" />
          <Stack gap={4}>
            {data.map(d => (
              <Group key={d.name} gap={6} wrap="nowrap">
                <span style={{ width: 10, height: 10, borderRadius: 3, background: `var(--mantine-color-${d.color.replace('.', '-')})` }} />
                <Text size="xs">{d.name}</Text><Text size="xs" fw={700}>{d.value}</Text>
              </Group>
            ))}
          </Stack>
        </Group>
      ) : <Text size="sm" c="dimmed">{t('chats.none')}</Text>}
    </Panel>
  );
}

// Subagents started per half hour over the last three hours, by type.
export function SubagentLoad({ state, now }) {
  const list = state.subagents || [];
  const other = t('chart.other');
  const { data, series } = useMemo(() => {
    const H = 6, step = 30 * 60e3, t0 = now - H * step;
    const types = [...new Set(list.map(a => a.type || '—'))];
    const top = types.map(x => [x, list.filter(a => (a.type || '—') === x).length]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
    const key = x => (top.includes(x) ? x : other);
    const keys = [...top, ...(types.length > top.length ? [other] : [])];
    const rows = Array.from({ length: H }, (_, i) => Object.assign({ t: hm(t0 + i * step) }, Object.fromEntries(keys.map(k => [k, 0]))));
    for (const a of list) {
      const i = Math.floor((a.started - t0) / step);
      if (i >= 0 && i < H) rows[i][key(a.type || '—')]++;
    }
    const colors = ['indigo.6', 'cyan.6', 'pink.6', 'yellow.6', 'gray.6'];
    return { data: rows, series: keys.map((k, i) => ({ name: k, color: colors[i] })) };
  }, [list, Math.floor(now / 60000)]);
  const running = list.filter(a => a.running).length;
  return (
    <Panel title={t('chart.subagents')} sub={t('chart.subagentsSub', { n: list.length, r: running })}>
      <BarChart h={200} data={data} dataKey="t" type="stacked" series={series} withLegend
        legendProps={{ verticalAlign: 'bottom', height: 30 }} tickLine="none" gridAxis="y" yAxisProps={{ allowDecimals: false, width: 28 }} />
    </Panel>
  );
}
