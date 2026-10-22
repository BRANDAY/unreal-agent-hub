import { useEffect, useMemo, useState } from 'react';
import { Badge, Group, Paper, SegmentedControl, Stack, Switch, Text, TextInput, ThemeIcon, Tooltip } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import {
  IconAlertOctagon, IconCircleX, IconCloud, IconHandStop, IconHelp, IconHourglassHigh, IconMessageCircle, IconPlayerPlayFilled, IconPlugX,
  IconRobot, IconSearch,
} from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
import { AgentBadge, OpenButton } from './Resources.jsx';
import { LANG, t } from './i18n.js';
import { RANK, STATE_COLOR, ago, bgType, full, isActive, isClosed, resColor, stateText, stateTip, store, viewState } from './util.js';

// Narrower than this (a side pane, a phone), tables keep the name first and fold the rest in a line under it.
export const COMPACT_PX = 900;
// A column that must stay this wide: the 100%-wide name column otherwise hands the spare width to the small ones.
export const fixed = w => ({ titleStyle: { width: w, minWidth: w, maxWidth: w }, cellsStyle: () => ({ width: w, minWidth: w, maxWidth: w }) });

const TABS = [
  ['active', isActive],
  ['owner', s => s.state === 'needs-owner' || viewState(s) === 'stalled'],
  ['background', s => s.state === 'background' || (s.background || []).length > 0 || s.subagents > 0],
  ['all', () => true],
  ['closed', isClosed],
];

const ICON = {
  'needs-owner': IconHandStop, stalled: IconAlertOctagon, working: IconPlayerPlayFilled, background: IconHourglassHigh,
  idle: IconMessageCircle, unknown: IconHelp, gone: IconPlugX, ended: IconCircleX,
};
const LIVE = v => v === 'working' || v === 'background';

// The state as one coloured icon (narrow layout), with the label and its meaning in the tooltip.
export function StateIcon({ s, size = 26 }) {
  const v = viewState(s), Icon = ICON[v] || IconHelp, tip = stateTip(v);
  return (
    <Tooltip label={<><b>{stateText(v)}</b>{tip ? <div>{tip}</div> : null}</>} multiline w={260} withArrow position="right">
      <ThemeIcon size={size} radius="xl" variant={v === 'needs-owner' || v === 'stalled' ? 'filled' : 'light'} color={STATE_COLOR[v] || 'gray'}>
        <Icon size={size * 0.55} className={LIVE(v) ? 'pulse' : undefined} />
      </ThemeIcon>
    </Tooltip>
  );
}

export function StateBadge({ s }) {
  const v = viewState(s), tip = stateTip(v);
  return (
    <Tooltip label={tip} multiline w={260} withArrow disabled={!tip}>
      <Badge color={STATE_COLOR[v] || 'gray'} variant={LIVE(v) || v === 'needs-owner' ? 'light' : 'outline'} size="sm"
        leftSection={<span className={LIVE(v) ? 'pulse' : ''} style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: 'currentColor' }} />}>
        {stateText(v)}
      </Badge>
    </Tooltip>
  );
}

// What runs behind the chat: background tasks from its last Stop, plus live subagents not listed there.
function BgChips({ s }) {
  const bg = s.background || [];
  const byType = new Map();
  for (const x of bg) byType.set(x.type, (byType.get(x.type) || 0) + 1);
  const subsInBg = bg.filter(x => /agent/i.test(x.type)).length;
  const extraSubs = Math.max(0, (s.subagents || 0) - subsInBg);
  if (!byType.size && !extraSubs) return null;
  return (<>
    {[...byType].map(([type, n]) => {
      const m = bgType(type);
      return (
        <Tooltip key={type} label={bg.filter(x => x.type === type).map(x => x.description || x.command || x.id).join(' · ')} multiline w={320}>
          <Badge size="xs" color={m.color} variant="light" leftSection={/cloud/i.test(type) ? <IconCloud size={10} /> : null}>{m.label}{n > 1 ? ' ×' + n : ''}</Badge>
        </Tooltip>
      );
    })}
    {extraSubs ? <Badge size="xs" color="indigo" variant="light" leftSection={<IconRobot size={10} />}>{t('bg.subagent')}{extraSubs > 1 ? ' ×' + extraSubs : ''}</Badge> : null}
  </>);
}

function ResChips({ s, state }) {
  const res = key => state.resources.find(r => r.key === key) || { key, label: key };
  return (<>
    {s.holds.map(h => <Badge key={'h' + h} size="xs" variant="filled" style={{ background: resColor(res(h)) }}>{t('chats.holds', { r: res(h).label })}</Badge>)}
    {s.waits.map(h => <Badge key={'w' + h} size="xs" variant="outline" color="orange">{t('chats.waits', { r: res(h).label })}</Badge>)}
    {s.waitingFor && !s.waits.length ? <Badge size="xs" variant="outline" color="orange">{t('chats.waits', { r: res(s.waitingFor).label })}</Badge> : null}
  </>);
}

// A service prompt ("(background task notice)") says nothing: show what the chat last said instead.
const secondLine = s => (s.state === 'needs-owner' && s.notice ? s.notice
  : /^\(.*\)$/.test((s.lastPrompt || '').trim()) && s.lastReply ? s.lastReply : s.lastPrompt);

const Label = ({ k }) => <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{t(k)}</Text>;

function Detail({ s, subagents }) {
  const mine = subagents.filter(a => a.session === s.session && a.running);
  return (
    <Stack gap={6} p="sm" style={{ background: 'var(--mantine-color-default-hover)' }}>
      {s.notice ? <div><Label k="detail.notice" /><Text size="sm" c="orange">{s.notice}</Text></div> : null}
      {s.lastPrompt ? <div><Label k="detail.prompt" /><Text size="sm">{s.lastPrompt}</Text></div> : null}
      {s.lastReply ? <div><Label k="detail.reply" /><Text size="sm">{s.lastReply}</Text></div> : null}
      {(s.background || []).length ? <div>
        <Label k="detail.background" />
        {s.background.map(x => (
          <Group key={x.id} gap={6} wrap="nowrap">
            <Badge size="xs" color={bgType(x.type).color} variant="light" style={{ flex: 'none' }}>{bgType(x.type).label}</Badge>
            <Text size="sm" className="clamp1">{x.description || x.command || x.id}</Text>
          </Group>
        ))}
      </div> : null}
      {mine.length ? <div>
        <Label k="detail.subagents" />
        {mine.map(a => <Group key={a.id} gap={6} wrap="nowrap"><Badge size="xs" variant="outline" style={{ flex: 'none' }}>{a.type || '—'}</Badge><Text size="sm" className="clamp1">{a.description}</Text></Group>)}
      </div> : null}
      <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
        {s.hostSession || s.session}{s.parent ? ' · ' + t('detail.from', { id: s.parent }) : ''}{s.cwd ? ' · ' + s.cwd : ''}{s.archived ? ' · ' + t('chats.archived') : ''}
      </Text>
    </Stack>
  );
}

const SORT = {
  state: (a, b) => (RANK[viewState(a)] ?? 9) - (RANK[viewState(b)] ?? 9) || b.last - a.last,
  title: (a, b) => (a.title || '').localeCompare(b.title || '', LANG),
  last: (a, b) => b.last - a.last,
  subagents: (a, b) => (b.subagents || 0) - (a.subagents || 0) || b.last - a.last,
};

export default function Chats({ state, act }) {
  const { ref, width } = useElementSize();
  const compact = width > 0 && width < COMPACT_PX;
  const [tab, setTab] = useState(() => store.get('hub.tab', 'active'));
  const [showOld, setShowOld] = useState(() => store.get('hub.showOld', false));
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(() => store.get('hub.sort', { columnAccessor: 'state', direction: 'asc' }));
  const [expanded, setExpanded] = useState([]);
  useEffect(() => store.set('hub.tab', tab), [tab]);
  useEffect(() => store.set('hub.showOld', showOld), [showOld]);
  useEffect(() => store.set('hub.sort', sort), [sort]);

  const multiMachine = (state.nodes || []).length > 0;
  const pool = useMemo(() => state.sessions.filter(s => showOld || !s.old), [state.sessions, showOld]);
  const counts = Object.fromEntries(TABS.map(([k, f]) => [k, pool.filter(f).length]));
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const f = (TABS.find(x => x[0] === tab) || TABS[0])[1];
    const r = pool.filter(f).filter(s => !needle || [s.title, s.lastPrompt, s.session, s.hostSession, s.project, s.machine].some(v => (v || '').toLowerCase().includes(needle)));
    r.sort(SORT[sort.columnAccessor] || SORT.state);
    if (sort.direction === 'desc') r.reverse();
    return r;
  }, [pool, tab, needle, sort]);

  return (
    <Paper withBorder radius="md" ref={ref}>
      <Stack gap="xs" p="sm">
        <SegmentedControl size="xs" value={tab} onChange={setTab} fullWidth={compact}
          data={TABS.map(([k]) => ({ value: k, label: compact ? `${t('chats.tab.' + k)} ${counts[k]}` : `${t('chats.tab.' + k)} · ${counts[k]}` }))} />
        <Group justify="space-between" gap="sm">
          <TextInput size="xs" placeholder={t('chats.search')} leftSection={<IconSearch size={14} />} value={q} onChange={e => setQ(e.currentTarget.value)}
            style={{ flex: compact ? 1 : 'none' }} w={compact ? undefined : 260} />
          <Switch size="xs" checked={showOld} onChange={e => setShowOld(e.currentTarget.checked)} label={t('chats.showOld', { n: state.hidden || 0 })} />
        </Group>
      </Stack>
      <DataTable
        idAccessor="session"
        records={rows}
        highlightOnHover
        verticalSpacing="xs"
        horizontalSpacing={compact ? 'xs' : 'sm'}
        minHeight={rows.length ? 0 : 140}
        noRecordsText={needle ? t('chats.noMatch') : tab === 'owner' ? t('chats.noneOwner') : t('chats.none')}
        sortStatus={sort}
        onSortStatusChange={setSort}
        rowClassName={s => (isClosed(s) ? 'row-dim' : undefined)}
        rowExpansion={{ allowMultiple: true, expanded: { recordIds: expanded, onRecordIdsChange: setExpanded }, content: ({ record }) => <Detail s={record} subagents={state.subagents || []} /> }}
        columns={[
          { accessor: 'state', title: compact ? '' : t('col.state'), sortable: !compact, width: compact ? 40 : 190, ...(compact ? fixed(40) : {}),
            render: s => (compact ? <StateIcon s={s} /> : <StateBadge s={s} />) },
          {
            // width 100% + maxWidth 0: the column takes the free space and its text ends in "…" instead of widening it
            accessor: 'title', title: t('col.chat'), sortable: true, width: '100%', cellsStyle: () => ({ maxWidth: 0 }), render: s => {
              const second = secondLine(s), warn = s.state === 'needs-owner' && s.notice, v = viewState(s);
              return (
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <Text size="sm" fw={600} className={compact ? 'clamp2' : 'clamp1'} lh={1.3} title={s.title}>{s.title || t('chats.untitled')}</Text>
                    {compact ? null : (<>
                      <AgentBadge agent={s.agent} />
                      {multiMachine ? <Badge size="xs" variant="default" style={{ flex: 'none' }}>{s.machine}</Badge> : null}
                      {s.project ? <Badge size="xs" variant="default" style={{ flex: 'none' }}>{s.project}</Badge> : null}
                    </>)}
                  </Group>
                  {second ? <Text size="xs" c={warn ? 'orange' : 'dimmed'} className="clamp1" title={second}>{second}</Text> : null}
                  {compact ? (
                    <Group gap={4} mt={2}>
                      <Text size="xs" c={STATE_COLOR[v] || 'dimmed'} fw={600}>{stateText(v)}</Text>
                      <Text size="xs" c="dimmed" title={full(s.last)}>· {ago(s.last)}</Text>
                      <AgentBadge agent={s.agent} />
                      {multiMachine ? <Badge size="xs" variant="default">{s.machine}</Badge> : null}
                      <BgChips s={s} /><ResChips s={s} state={state} />
                    </Group>
                  ) : null}
                </Stack>
              );
            },
          },
          { accessor: 'subagents', title: t('col.background'), sortable: true, width: 200, hidden: compact, render: s => <Group gap={4}><BgChips s={s} /></Group> },
          { accessor: 'holds', title: t('col.resources'), width: 190, hidden: compact, render: s => <Group gap={4}><ResChips s={s} state={state} /></Group> },
          { accessor: 'last', title: t('col.activity'), sortable: true, width: 130, hidden: compact, render: s => <Text size="xs" c="dimmed" title={full(s.last)}>{ago(s.last)}</Text> },
          { accessor: 'actions', title: '', width: compact ? 44 : 120, ...(compact ? fixed(44) : {}), textAlign: 'right', render: s => <OpenButton host={s.hostSession} act={act} compact={compact} /> },
        ]}
      />
    </Paper>
  );
}
