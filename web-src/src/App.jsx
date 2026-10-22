import { useEffect, useState } from 'react';
import {
  ActionIcon, Accordion, Alert, Badge, Box, Button, Container, Grid, Group, Notification, Paper, SegmentedControl, Select, SimpleGrid, Stack,
  Text, ThemeIcon, Title, Tooltip, useComputedColorScheme, useMantineColorScheme,
} from '@mantine/core';
import { IconAlertTriangle, IconBell, IconCloud, IconPlugConnectedX, IconHourglass, IconLock, IconMessages, IconMoon, IconRobot, IconSun } from '@tabler/icons-react';
import Asks, { useAskAlerts } from './Asks.jsx';
import Resources, { Machines } from './Resources.jsx';
import Chats from './Chats.jsx';
import { Cloud, Subagents } from './Agents.jsx';
import { ChatTime, Load, States, SubagentLoad } from './Charts.jsx';
import Timeline from './Timeline.jsx';
import { LANG_NAMES, loadLang, t, tm } from './i18n.js';
import { hm, post, store, viewState } from './util.js';

const HOURS = [1, 3, 12, 24];

function Kpi({ icon: Icon, color, value, total, label, alert }) {
  return (
    <Paper withBorder radius="md" p="md" style={alert ? { borderColor: 'var(--mantine-color-orange-6)' } : undefined}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div>
          <Text fz={30} fw={700} lh={1}>{value}{total != null ? <Text span fz="md" c="dimmed" fw={500}> / {total}</Text> : null}</Text>
          <Text size="xs" c="dimmed" mt={6}>{label}</Text>
        </div>
        <ThemeIcon size={38} radius="md" variant="light" color={color} visibleFrom="sm"><Icon size={20} /></ThemeIcon>
      </Group>
    </Paper>
  );
}

function Section({ title, sub, right, children }) {
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-end">
        <Group gap="sm" align="baseline"><Title order={3} fz="lg">{title}</Title>{sub ? <Text size="xs" c="dimmed">{sub}</Text> : null}</Group>
        {right}
      </Group>
      {children}
    </Stack>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [live, setLive] = useState(false);
  const [now, setNow] = useState(Date.now());
  // ?win=1|3|12|24 (hours) picks the window for a link or a screenshot; otherwise the last choice.
  const [win, setWin] = useState(() => {
    const h = +new URLSearchParams(location.search).get('win');
    return HOURS.includes(h) ? h * 3600e3 : +store.raw('hub.win', 3 * 3600e3) || 3 * 3600e3;
  });
  const [tip, setTip] = useState(null);
  const [toast, setToast] = useState(null);
  const [lang, setLang] = useState(null);
  const [, force] = useState(0);
  const { setColorScheme } = useMantineColorScheme();
  const dark = useComputedColorScheme('light') === 'dark';
  useAskAlerts(state);

  const act = async (kind, body) => {
    const r = await post('api/' + kind, body);
    const done = { break: t('toast.broken'), open: t('toast.opening'), 'node/probe': t('toast.probing'), presence: body.on ? t('toast.here') : t('toast.left'),
      grant: t('toast.granted'), decline: t('toast.declined') };
    setToast({ ok: r.ok, text: r.ok ? done[kind] || t('toast.done') : tm(r.errorMsg || r.error) || t('toast.failed') });
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
    const pick = [urlLang, store.raw('hub.lang', ''), state.lang, nav].find(l => l && (state.langs || []).includes(l)) || 'en';
    loadLang(pick).then(() => { setLang(pick); document.title = state.name; });
  }, [state]);
  useEffect(() => { store.setRaw('hub.win', String(win)); }, [win]);

  if (!state || !lang) return <Container py="xl"><Text c="dimmed">{state && state.error ? state.error : '…'}</Text></Container>;
  if (state.error) return <Container py="xl"><Text c="red">{state.error}</Text></Container>;

  const chooseLang = async l => { if (!l) return; store.setRaw('hub.lang', l); await loadLang(l); setLang(l); };
  const hostOf = sid => (state.sessions.find(s => s.session === sid) || {}).hostSession || '';
  const sessions = state.sessions.filter(s => !s.old);
  const count = f => sessions.filter(f).length;
  const working = count(s => viewState(s) === 'working'), background = count(s => s.state === 'background');
  const stalled = count(s => viewState(s) === 'stalled'), idle = count(s => s.state === 'idle'), owner = count(s => s.state === 'needs-owner');
  const asking = (state.asks || []).filter(a => a.state === 'pending').length;
  const need = owner + stalled + asking;
  const busy = state.resources.filter(r => r.lock && !r.lock.stale).length;
  const queued = state.resources.reduce((s, r) => s + r.waiters.length, 0);
  const subRunning = (state.subagents || []).filter(a => a.running).length;
  const needText = need ? [owner + asking ? t('kpi.ownerSome', { n: owner + asking }) : '', stalled ? t('kpi.stalled', { n: stalled }) : ''].filter(Boolean).join(' · ') : t('kpi.ownerNone');

  return (
    <Container key={lang} fluid px={{ base: 'md', md: 'xl' }} py="md" maw={1680}>
      <Group justify="space-between" mb="lg" wrap="nowrap" gap="xs" align="flex-start">
        <Group gap="sm" style={{ minWidth: 0 }}>
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true" style={{ flex: 'none' }}><rect x="3" y="12" width="6" height="14" rx="2" fill="var(--mantine-color-blue-6)" /><rect x="13" y="5" width="6" height="21" rx="2" fill="var(--mantine-color-teal-6)" /><rect x="23" y="15" width="6" height="11" rx="2" fill="var(--mantine-color-violet-6)" /></svg>
          <Title order={2} fz={{ base: 'md', sm: 'xl' }}>{state.name}</Title>
          <Text c="dimmed" size="sm" visibleFrom="sm">· {state.hub.label}</Text>
          <Badge variant="dot" color={live ? 'green' : 'red'} size="md">{live ? t('live.on', { time: hm(state.at) }) : t('live.off')}</Badge>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {window.Notification && Notification.permission === 'default'
            ? (<>
              <Button size="xs" variant="default" visibleFrom="sm" leftSection={<IconBell size={14} />} onClick={() => Notification.requestPermission().then(() => force(x => x + 1))}>{t('notify.enable')}</Button>
              <Tooltip label={t('notify.enable')}>
                <ActionIcon variant="default" size="lg" hiddenFrom="sm" aria-label={t('notify.enable')} onClick={() => Notification.requestPermission().then(() => force(x => x + 1))}><IconBell size={18} /></ActionIcon>
              </Tooltip>
            </>)
            : null}
          <Select size="xs" w={{ base: 110, sm: 130 }} value={lang} onChange={chooseLang} aria-label={t('lang.label')} allowDeselect={false}
            data={(state.langs || ['en']).map(l => ({ value: l, label: LANG_NAMES[l] || l }))} />
          <Tooltip label={dark ? t('theme.light') : t('theme.dark')}>
            <ActionIcon variant="default" size="lg" aria-label={dark ? t('theme.light') : t('theme.dark')} onClick={() => setColorScheme(dark ? 'light' : 'dark')}>
              {dark ? <IconSun size={18} /> : <IconMoon size={18} />}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {live ? null : <Alert color="red" variant="light" mb="md" icon={<IconPlugConnectedX size={18} />}>{t('live.stale', { time: hm(state.at) })}</Alert>}
      <Asks state={state} now={now} act={act} live={live} />

      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="md" mb="xl">
        <Kpi icon={IconAlertTriangle} color={need ? 'orange' : 'gray'} value={need} alert={need > 0} label={needText} />
        <Kpi icon={IconMessages} color="green" value={working} total={working + background + idle + stalled + owner} label={t('kpi.chats')} />
        <Kpi icon={IconHourglass} color="cyan" value={background} label={t('kpi.background')} />
        <Kpi icon={IconRobot} color="indigo" value={subRunning} label={t('kpi.subagents')} />
        <Kpi icon={IconLock} color="violet" value={busy} total={state.resources.length} label={queued ? t('kpi.resources', { n: queued }) : t('kpi.resourcesNoQueue')} />
        <Kpi icon={IconCloud} color="cyan" value={(state.cloud || []).length} label={t('kpi.cloud')} />
      </SimpleGrid>

      <Stack gap="xl">
        <Section title={t('h.resources')}><Resources state={state} now={now} act={act} hostOf={hostOf} /></Section>
        {(state.nodes || []).length ? <Section title={t('h.machines')}><Machines state={state} now={now} act={act} /></Section> : null}
        <Section title={t('h.chats')} sub={t('h.chatsSub')}><Chats state={state} act={act} /></Section>
        <Section title={t('h.subagents')} sub={t('h.subagentsSub')}><Subagents state={state} act={act} now={now} /></Section>
        <Section title={t('h.cloud')} sub={t('h.cloudSub')}><Cloud state={state} act={act} /></Section>
        <Section title={t('h.window')} right={<SegmentedControl size="xs" value={String(win)} onChange={v => setWin(Number(v))} data={HOURS.map(h => ({ label: t('tl.hours', { n: h }), value: String(h * 3600e3) }))} />}>
          <Grid gutter="md">
            <Grid.Col span={{ base: 12, lg: 8 }}><ChatTime state={state} now={now} win={win} /></Grid.Col>
            <Grid.Col span={{ base: 12, lg: 4 }}><States state={state} /></Grid.Col>
            <Grid.Col span={{ base: 12, lg: 6 }}><Load state={state} now={now} win={win} /></Grid.Col>
            <Grid.Col span={{ base: 12, lg: 6 }}><SubagentLoad state={state} now={now} /></Grid.Col>
          </Grid>
          <Text fw={600} mt="xs">{t('h.timeline')}</Text>
          <Timeline state={state} now={now} win={win} setTip={setTip} />
        </Section>
        <Accordion variant="contained" radius="md">
          <Accordion.Item value="log">
            <Accordion.Control><Text size="sm">{t('h.log')}</Text></Accordion.Control>
            <Accordion.Panel><Box component="pre" fz="xs" style={{ overflowX: 'auto', margin: 0 }}>{(state.log || []).join('\n') || t('log.empty')}</Box></Accordion.Panel>
          </Accordion.Item>
        </Accordion>
        <Text size="xs" c="dimmed">{t('foot')} {t('foot.background')}</Text>
      </Stack>

      {tip ? <div className="board-tip" style={{ left: Math.min(tip.x, innerWidth - 330), top: Math.min(tip.y, innerHeight - 90) }}>
        {tip.lines.filter(Boolean).map((l, i) => (i ? <div key={i}>{l}</div> : <b key={i}>{l}</b>))}
      </div> : null}
      {toast ? <Notification color={toast.ok ? 'green' : 'red'} withCloseButton={false} style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 400 }}>{toast.text}</Notification> : null}
    </Container>
  );
}
