import { useEffect, useMemo, useState } from 'react';
import { Anchor, Badge, Card, Group, Paper, SegmentedControl, SimpleGrid, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconCloud, IconExternalLink, IconRobot } from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
import { useElementSize } from '@mantine/hooks';
import { OpenButton } from './Resources.jsx';
import { COMPACT_PX, fixed } from './Chats.jsx';
import { has, t } from './i18n.js';
import { ago, chatColor, full, human, store } from './util.js';

const TYPE_COLOR = { Explore: 'cyan', 'general-purpose': 'indigo', Plan: 'grape', 'claude-code-guide': 'yellow', 'web-fetch': 'lime' };
const QUIET_MS = 5 * 60e3;

function SubState({ a, now, compact }) {
  const quiet = a.running && now - a.last > QUIET_MS;
  const label = a.running ? (quiet ? t('sub.st.quiet') : t('sub.st.working')) : a.stopped ? t('sub.st.stopped') : t('sub.st.done');
  const color = a.running ? (quiet ? 'yellow' : 'green') : a.stopped ? 'red' : 'gray';
  const dot = <span className={a.running && !quiet ? 'pulse' : ''} style={{ display: 'inline-block', width: compact ? 10 : 6, height: compact ? 10 : 6, borderRadius: 5, background: compact ? `var(--mantine-color-${color}-6)` : 'currentColor' }} />;
  return compact
    ? <Tooltip label={label} withArrow position="right">{dot}</Tooltip>
    : <Badge size="sm" variant={a.running ? 'light' : 'outline'} color={color} leftSection={a.running ? dot : null}>{label}</Badge>;
}

function TypeChips({ a }) {
  return (<>
    <Badge size="xs" variant="light" color={TYPE_COLOR[a.type] || 'gray'}>{a.type || '—'}</Badge>
    {a.model ? <Badge size="xs" variant="outline" color="gray">{a.model}</Badge> : null}
    {a.background ? <Tooltip label={t('sub.bgTip')}><Badge size="xs" variant="dot" color="cyan">{t('sub.bg')}</Badge></Tooltip> : null}
  </>);
}

function ChatName({ a }) {
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, flex: 'none', background: chatColor(a.session) }} />
      <Text size="xs" className="clamp1" title={a.chat}>{a.chat || a.session.slice(0, 8)}</Text>
    </Group>
  );
}

// Subagents of every Claude Code chat on this machine: what each one does (the Agent call's description), whose
// it is, for how long. In a narrow pane: a state dot, the task (two lines) with chat, type and time under it.
export function Subagents({ state, act, now }) {
  const { ref, width } = useElementSize();
  const compact = width > 0 && width < COMPACT_PX;
  const [mode, setMode] = useState(() => store.get('hub.subMode', 'running'));
  useEffect(() => store.set('hub.subMode', mode), [mode]);
  const all = state.subagents || [];
  const running = all.filter(a => a.running);
  const rows = useMemo(() => (mode === 'running' ? running : all), [mode, all]);
  return (
    <Paper withBorder radius="md" ref={ref}>
      <Group justify="space-between" p="sm">
        <SegmentedControl size="xs" value={mode} onChange={setMode} fullWidth={compact} style={compact ? { flex: 1 } : undefined}
          data={[{ value: 'running', label: t('sub.running', { n: running.length }) }, { value: 'recent', label: t('sub.recent', { n: all.length }) }]} />
        {compact ? null : <Text size="xs" c="dimmed">{t('sub.hint')}</Text>}
      </Group>
      <DataTable
        idAccessor={a => a.session + a.id}
        records={rows}
        highlightOnHover
        verticalSpacing="xs"
        horizontalSpacing={compact ? 'xs' : 'sm'}
        minHeight={rows.length ? 0 : 120}
        noRecordsText={mode === 'running' ? t('sub.noneRunning') : t('sub.noneRecent')}
        rowClassName={a => (a.running ? undefined : 'row-dim')}
        columns={[
          { accessor: 'running', title: compact ? '' : t('col.state'), width: compact ? 28 : 130, ...(compact ? fixed(28) : {}), render: a => <SubState a={a} now={now} compact={compact} /> },
          {
            accessor: 'description', title: t('col.task'), width: '100%', cellsStyle: () => ({ maxWidth: 0 }), render: a => (
              <Stack gap={3} style={{ minWidth: 0 }}>
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  {compact ? null : <ThemeIcon size="sm" variant="light" color={TYPE_COLOR[a.type] || 'gray'}><IconRobot size={13} /></ThemeIcon>}
                  <Text size="sm" fw={600} className={compact ? 'clamp2' : 'clamp1'} lh={1.3} title={a.description}>{a.description || a.id}</Text>
                </Group>
                {compact ? (<>
                  <ChatName a={a} />
                  <Group gap={4}>
                    <TypeChips a={a} />
                    <Text size="xs" c="dimmed">{human((a.running ? now : a.last) - a.started)} · {t('sub.step', { ago: ago(a.last) })}</Text>
                  </Group>
                </>) : null}
              </Stack>
            ),
          },
          { accessor: 'type', title: t('col.type'), width: 250, hidden: compact, render: a => <Group gap={4} wrap="nowrap"><TypeChips a={a} /></Group> },
          { accessor: 'chat', title: t('col.chat'), width: 260, hidden: compact, render: a => <ChatName a={a} /> },
          { accessor: 'started', title: t('col.running'), width: 120, hidden: compact, render: a => <Text size="xs" c="dimmed" title={t('sub.startedAt', { time: full(a.started) })}>{human((a.running ? now : a.last) - a.started)}</Text> },
          { accessor: 'last', title: t('col.lastStep'), width: 130, hidden: compact, render: a => <Text size="xs" c="dimmed" title={full(a.last)}>{ago(a.last)}</Text> },
          { accessor: 'open', title: '', width: compact ? 44 : 60, ...(compact ? fixed(44) : {}), textAlign: 'right', render: a => <OpenButton host={a.hostSession} act={act} compact /> },
        ]}
      />
    </Paper>
  );
}

const CLOUD_COLOR = { running: 'cyan', pending: 'cyan', completed: 'green', seen: 'gray', unknown: 'gray' };

// Cloud sessions run no local hooks: the board knows them from the chat that started them (the PostToolUse hook of
// start_session, and the desktop app's own list), so their state is "started from <chat>" plus a link.
export function Cloud({ state, act }) {
  const list = state.cloud || [];
  if (!list.length) return <Text size="sm" c="dimmed">{t('cloud.none')}</Text>;
  return (
    <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
      {list.map(c => {
        const label = has('cloud.st.' + c.status) ? t('cloud.st.' + c.status) : c.status;
        return (
          <Card key={c.remote || c.task} withBorder padding="md">
            <Group justify="space-between" wrap="nowrap" mb={6}>
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <ThemeIcon variant="light" color="cyan"><IconCloud size={16} /></ThemeIcon>
                <Text fw={600} size="sm" className="clamp1" title={c.title}>{c.title || c.remote || c.task}</Text>
              </Group>
              <Tooltip label={t('cloud.seenTip')} disabled={c.status !== 'seen'} multiline w={260}>
                <Badge size="sm" color={CLOUD_COLOR[c.status] || 'gray'} variant="light" style={{ flex: 'none' }}>{label}</Badge>
              </Tooltip>
            </Group>
            <Stack gap={4}>
              <Group gap={6} wrap="nowrap">
                <Text size="xs" c="dimmed" style={{ flex: 'none' }}>{t('cloud.from')}</Text>
                <Text size="xs" className="clamp1" title={c.parentTitle}>{c.parentTitle || c.parentSession.slice(0, 8)}</Text>
                <OpenButton host={c.hostSession} act={act} compact />
              </Group>
              {c.started ? <Text size="xs" c="dimmed">{t('cloud.started', { ago: ago(c.started), time: full(c.started) })}</Text> : null}
              {c.url ? <Anchor size="xs" href={c.url} target="_blank" rel="noreferrer"><Group gap={4}>{t('cloud.open')} <IconExternalLink size={12} /></Group></Anchor> : null}
            </Stack>
          </Card>
        );
      })}
    </SimpleGrid>
  );
}
