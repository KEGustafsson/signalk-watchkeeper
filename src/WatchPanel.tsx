import React from 'react';
import {
  createLatestGate,
  earlierLineText,
  incidentText,
  incidentView,
  sinceText,
  reportText,
  unusualText,
  describeCompileEvidence,
  describeDetectorCounts,
  describeInventoryRow,
  formatAgo,
  formatClockTime,
  sparklinePoints,
  storedRule
} from './watchText.js';
import { COPIED_MS, copyText } from './clipboard.js';
import type { IncidentLine, WatchFinding, WatchIncident, WatchInventory, WatchReplayResult, WatchReport, WatchRuleCompileResult, WatchStatus, WatchUnusualRow } from './watchText.js';

interface WatchPanelProps {
  readonly fetchImpl?: typeof fetch;
  /** `/watch/status` -> the plugin's full URL for it. */
  readonly endpoint: (route: string) => string;
}

const COPY_REFUSED = 'This browser did not allow copying, so the text is shown below: select it and copy it by hand.';

// The status route reads in-memory state only - no backend, no provider - so
// polling it is cheap.
const POLL_MS = 10000;

const SEVERITY_STYLE = {
  alert: { background: '#fef2f2', border: '#fca5a5', color: '#991b1b', label: 'Alert' },
  warn: { background: '#fffbeb', border: '#fcd34d', color: '#92400e', label: 'Warning' }
} as const;

const GNSS_LABEL = {
  ok: { text: 'corroborated', color: '#166534' },
  degraded: { text: 'one indicator active', color: '#b45309' },
  suspect: { text: 'not corroborated: treat the position with suspicion', color: '#b91c1c' },
  lost: { text: 'no fix arriving: the position shown elsewhere is old', color: '#b91c1c' },
  unavailable: { text: 'no position data', color: '#475569' }
} as const;

const buttonStyle = {
  padding: '0.3rem 0.65rem',
  borderRadius: '6px',
  border: '1px solid #94a3b8',
  background: '#ffffff',
  color: '#0f172a',
  cursor: 'pointer'
} as const;

type Series = ReadonlyArray<readonly [number, number]>;

async function readJson(response: Response): Promise<{ ok: boolean; status: number; body: unknown }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

function errorText(status: number, body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
  if (status === 401) {
    return message ?? 'This needs a Signal K login with write access.';
  }
  return message ?? fallback;
}

/** Every character of a text box selected; iOS selects nothing on select() alone. */
function selectAll(area: HTMLTextAreaElement): void {
  area.select();
  area.setSelectionRange(0, area.value.length);
}

export default function WatchPanel(props: WatchPanelProps) {
  const [status, setStatus] = React.useState<WatchStatus | null>(null);
  const [unreachable, setUnreachable] = React.useState<boolean>(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [trends, setTrends] = React.useState<Record<string, Series | 'loading' | 'none'>>({});
  const [replay, setReplay] = React.useState<WatchReplayResult | 'running' | null>(null);
  const [showResolved, setShowResolved] = React.useState<boolean>(false);
  // Incidents whose earlier, back-to-normal lines are all shown.
  const [showAllEarlier, setShowAllEarlier] = React.useState<Record<string, boolean>>({});
  const [refresh, setRefresh] = React.useState<number>(0);
  const [now, setNow] = React.useState<number>(Date.now());
  const [updatedAt, setUpdatedAt] = React.useState<number | null>(null);
  const [inventory, setInventory] = React.useState<WatchInventory | 'loading' | { error: string } | null>(null);
  const [inventoryFilter, setInventoryFilter] = React.useState<string>('');
  const [report, setReport] = React.useState<WatchReport | 'loading' | { error: string } | null>(null);
  const [ruleText, setRuleText] = React.useState<string>('');
  // Which compile request is current. A reply for text the operator has since
  // changed, or one overtaken by a later request, must not put its read-back
  // (and its "Add this watch") beside different text.
  const [compileGeneration] = React.useState<{ current: number }>({ current: 0 });
  const [compiled, setCompiled] = React.useState<WatchRuleCompileResult | 'working' | null>(null);
  const [unusual, setUnusual] = React.useState<readonly WatchUnusualRow[] | 'loading' | { error: string } | null>(null);
  // What was last copied: 'report', 'unusual' or an incident id. It reads
  // "Copied" for a moment, then as a button again.
  const [copied, setCopied] = React.useState<string | null>(null);
  // Text the browser would not copy by either means, shown for copying by hand.
  const [manualCopy, setManualCopy] = React.useState<string | null>(null);
  // Bumped on every refused copy, so the box is built again and its new text
  // is selected, even when the text is the same.
  const [manualCopyKey, setManualCopyKey] = React.useState<number>(0);
  // `latest` numbers each copy, so an older copy that settles late cannot
  // undo a newer one.
  const [copiedTimer] = React.useState<{ current: ReturnType<typeof setTimeout> | undefined; alive: boolean; latest: number }>({
    current: undefined,
    alive: true,
    latest: 0
  });
  React.useEffect(() => {
    copiedTimer.alive = true;
    return () => {
      copiedTimer.alive = false;
      clearTimeout(copiedTimer.current);
    };
  }, [copiedTimer]);
  // The box goes, and the notice that pointed at it goes with it.
  const closeManualCopy = React.useCallback(() => {
    setManualCopy(null);
    setNotice((current) => (current === COPY_REFUSED ? null : current));
  }, []);
  const copyFor = React.useCallback((key: string, text: string) => {
    copiedTimer.latest += 1;
    const turn = copiedTimer.latest;
    void copyText(text).then((outcome) => {
      if (!copiedTimer.alive || turn !== copiedTimer.latest) return;
      if (outcome === 'refused') {
        setCopied(null);
        setManualCopy(text);
        setManualCopyKey((count) => count + 1);
        setNotice(COPY_REFUSED);
        return;
      }
      closeManualCopy();
      setCopied(key);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied((current) => (current === key ? null : current)), COPIED_MS);
    });
  }, [copiedTimer, closeManualCopy]);

  const fetchImpl = props.fetchImpl ?? globalThis.fetch;
  const statusUrl = props.endpoint('/watch/status');

  React.useEffect(() => {
    if (typeof fetchImpl !== 'function') {
      return;
    }
    let active = true;
    // A slow poll must not put an older snapshot back over a newer one.
    const gate = createLatestGate();
    const load = () => {
      const turn = gate.begin();
      fetchImpl(statusUrl, { method: 'GET', credentials: 'include' })
        .then(readJson)
        .then(({ ok, body }) => {
          if (!active || !gate.accept(turn)) return;
          setUnreachable(!ok);
          if (ok) {
            setStatus(body as WatchStatus);
            setUpdatedAt(Date.now());
          }
          setNow(Date.now());
        })
        .catch(() => {
          if (active && gate.accept(turn)) setUnreachable(true);
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [fetchImpl, statusUrl, refresh]);

  const post = React.useCallback(
    async (route: string, body: unknown) => {
      if (typeof fetchImpl !== 'function') {
        throw new Error('This browser cannot reach the plugin.');
      }
      const response = await fetchImpl(props.endpoint(route), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      return readJson(response);
    },
    [fetchImpl, props.endpoint]
  );

  const onMute = React.useCallback(
    async (path: string, minutes: number) => {
      setNotice(null);
      try {
        const result = await post('/watch/mute', { path, minutes });
        setNotice(result.ok ? `Muted ${path} for ${minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`}.` : errorText(result.status, result.body, 'Could not mute.'));
        setRefresh((value) => value + 1);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not mute.');
      }
    },
    [post]
  );

  const onFeedback = React.useCallback(
    async (path: string, useful: boolean | 'reset') => {
      setNotice(null);
      try {
        const result = await post('/watch/feedback', { path, useful });
        const factor = (result.body as { factor?: number } | undefined)?.factor;
        setNotice(
          result.ok
            ? useful === false
              ? `Noted. ${path} now needs a ${factor && factor > 1 ? `${Math.round((factor - 1) * 100)} % ` : ''}bigger change before it is reported again.`
              : `${path} is back to normal sensitivity${factor && factor > 1 ? ` (still ${Math.round((factor - 1) * 100)} % less sensitive)` : ''}.`
            : errorText(result.status, result.body, 'Could not record that.')
        );
        setRefresh((value) => value + 1);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not record that.');
      }
    },
    [post]
  );

  const onReport = React.useCallback(async () => {
    if (report && report !== 'loading') {
      setReport(null);
      return;
    }
    if (typeof fetchImpl !== 'function') return;
    setReport('loading');
    try {
      const response = await fetchImpl(`${props.endpoint('/watch/report')}?hours=24`, { method: 'GET', credentials: 'include' });
      const { ok, status: code, body } = await readJson(response);
      setReport(ok ? (body as WatchReport) : { error: errorText(code, body, 'Could not build the report.') });
    } catch (error) {
      setReport({ error: error instanceof Error ? error.message : 'Could not build the report.' });
    }
  }, [fetchImpl, props.endpoint, report]);

  const onUnmute = React.useCallback(
    async (path: string) => {
      setNotice(null);
      try {
        const result = await post('/watch/unmute', { path });
        setNotice(result.ok ? `Watching ${path} again.` : errorText(result.status, result.body, 'Could not unmute.'));
        setRefresh((value) => value + 1);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not unmute.');
      }
    },
    [post]
  );

  const onReplay = React.useCallback(async () => {
    setReplay('running');
    try {
      const result = await post('/watch/replay', { duration: 'PT24H' });
      setReplay(
        result.ok
          ? (result.body as WatchReplayResult)
          : { ok: false, message: errorText(result.status, result.body, 'The replay failed.') }
      );
    } catch (error) {
      setReplay({ ok: false, message: error instanceof Error ? error.message : 'The replay failed.' });
    }
  }, [post]);

  const onInventory = React.useCallback(async () => {
    if (inventory && inventory !== 'loading') {
      setInventory(null);
      return;
    }
    if (typeof fetchImpl !== 'function') return;
    setInventory('loading');
    try {
      const response = await fetchImpl(props.endpoint('/watch/inventory'), { method: 'GET', credentials: 'include' });
      const { ok, status: code, body } = await readJson(response);
      setInventory(ok ? (body as WatchInventory) : { error: errorText(code, body, 'Could not read the inventory.') });
    } catch (error) {
      setInventory({ error: error instanceof Error ? error.message : 'Could not read the inventory.' });
    }
  }, [fetchImpl, inventory, props.endpoint]);

  const onUnusual = React.useCallback(async () => {
    if (unusual && unusual !== 'loading') {
      setUnusual(null);
      return;
    }
    if (typeof fetchImpl !== 'function') return;
    setUnusual('loading');
    try {
      const response = await fetchImpl(props.endpoint('/watch/unusual'), { method: 'GET', credentials: 'include' });
      const { ok, status: code, body } = await readJson(response);
      setUnusual(ok ? ((body as { rows?: readonly WatchUnusualRow[] }).rows ?? []) : { error: errorText(code, body, 'Could not rank paths.') });
    } catch (error) {
      setUnusual({ error: error instanceof Error ? error.message : 'Could not rank paths.' });
    }
  }, [fetchImpl, props.endpoint, unusual]);

  const onCompile = React.useCallback(
    async (path?: string) => {
      if (!ruleText.trim()) return;
      compileGeneration.current += 1;
      const generation = compileGeneration.current;
      setCompiled('working');
      try {
        const result = await post('/watch/rules/compile', { text: ruleText, ...(path ? { path } : {}) });
        if (generation !== compileGeneration.current) return;
        setCompiled(
          result.ok
            ? (result.body as WatchRuleCompileResult)
            : { ok: false, reason: errorText(result.status, result.body, 'Could not read that.') }
        );
      } catch (error) {
        if (generation !== compileGeneration.current) return;
        setCompiled({ ok: false, reason: error instanceof Error ? error.message : 'Could not read that.' });
      }
    },
    [compileGeneration, post, ruleText]
  );

  // One rule per request, applied on the server to the rules as they are
  // stored now. Sending the whole list from this panel's last poll could undo
  // an edit made elsewhere in the ten seconds since, or bring back a rule a
  // quick second click had just removed.
  const changeRule = React.useCallback(
    async (
      route: '/watch/rules/add' | '/watch/rules/remove',
      body: unknown,
      done: string,
      submitted?: { readonly generation: number }
    ) => {
      setNotice(null);
      try {
        const result = await post(route, body);
        // A remove that finds nothing - a quick second click, another panel
        // got there first, or an id that is no longer the watch's. Which one
        // is not known here, so the notice says only what is: the list is
        // read again below, and shows whether the watch is still there.
        const notStored = route === '/watch/rules/remove' && result.status === 404;
        setNotice(
          result.ok
            ? done
            : notStored
              ? 'No watch is stored under that id any more; the list has been read again.'
              : errorText(result.status, result.body, 'Could not save the watch rules.')
        );
        // Only the draft that was added is cleared, text and read-back
        // together - not when the editor changed or a new read-back started
        // while the request was pending (each bumps the draft generation),
        // and not at all when a stored watch was removed.
        if (result.ok && submitted && submitted.generation === compileGeneration.current) {
          setCompiled(null);
          setRuleText('');
        }
        setRefresh((value) => value + 1);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not save the watch rules.');
      }
    },
    [compileGeneration, post]
  );

  const onAddRule = React.useCallback(async () => {
    if (!compiled || compiled === 'working' || !compiled.ok || !compiled.rule) return;
    await changeRule('/watch/rules/add', { rule: storedRule(compiled.rule) }, 'Watch added.', {
      generation: compileGeneration.current
    });
  }, [changeRule, compileGeneration, compiled]);

  const onDeleteRule = React.useCallback(
    async (id: string) => {
      await changeRule('/watch/rules/remove', { id }, 'Watch removed.');
    },
    [changeRule]
  );

  const onTrend = React.useCallback(
    async (path: string) => {
      if (typeof fetchImpl !== 'function') return;
      if (trends[path] && trends[path] !== 'none') {
        setTrends((previous) => {
          const { [path]: _removed, ...rest } = previous;
          return rest;
        });
        return;
      }
      setTrends((previous) => ({ ...previous, [path]: 'loading' }));
      try {
        const response = await fetchImpl(`${props.endpoint('/watch/series')}?path=${encodeURIComponent(path)}`, {
          method: 'GET',
          credentials: 'include'
        });
        const { ok, body } = await readJson(response);
        const series = ok ? (body as { minutes?: Series; recent?: Series }) : undefined;
        const points = series && Array.isArray(series.minutes) && series.minutes.length >= 2 ? series.minutes : series?.recent;
        setTrends((previous) => ({ ...previous, [path]: points && points.length >= 2 ? points : 'none' }));
      } catch {
        setTrends((previous) => ({ ...previous, [path]: 'none' }));
      }
    },
    [fetchImpl, props.endpoint, trends]
  );

  const incidents = status?.incidents ?? [];
  const activeIncidents = incidents.filter((incident) => incident.status === 'active');
  const resolvedIncidents = incidents.filter((incident) => incident.status === 'resolved').slice(0, 10);

  const renderActions = (finding: WatchFinding) => {
    const trend = trends[finding.path];
    const canTrend = !finding.detector.startsWith('gnss.') && finding.detector !== 'feed';
    return (
      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
        {canTrend ? (
          <button type="button" style={buttonStyle} onClick={() => onTrend(finding.path)}>
            {trend && trend !== 'none' ? 'Hide trend' : 'Trend'}
          </button>
        ) : null}
        {finding.detector !== 'feed' ? (
          <button type="button" style={buttonStyle} onClick={() => onMute(finding.path, 60)}>
            Mute 1 h
          </button>
        ) : null}
        {finding.detector !== 'feed' && finding.detector !== 'rule' ? (
          <button
            type="button"
            style={buttonStyle}
            title="Make this path need a bigger change before it is reported again. Wears off over a few weeks."
            onClick={() => onFeedback(finding.path, false)}
          >
            Not useful
          </button>
        ) : null}
      </div>
    );
  };

  // The trend of an open finding, with the exact figures it was measured as.
  const renderTrend = (finding: WatchFinding, color: string) => {
    const trend = trends[finding.path];
    return (
      <>
        {trend === 'loading' ? <p style={{ margin: '0.3rem 0 0 0', color: '#475569' }}>Loading trend…</p> : null}
        {trend === 'none' ? <p style={{ margin: '0.3rem 0 0 0', color: '#475569' }}>No trend recorded yet.</p> : null}
        {Array.isArray(trend) ? (
          <>
            <svg
              role="img"
              aria-label={`Trend of ${finding.path} over the last ${Math.round((trend[trend.length - 1][0] - trend[0][0]) / 60000)} minutes`}
              width="100%"
              height="40"
              viewBox="0 0 240 40"
              preserveAspectRatio="none"
              style={{ display: 'block', marginTop: '0.3rem', background: '#ffffff', borderRadius: '4px', border: '1px solid #e2e8f0' }}
            >
              <polyline fill="none" stroke={color} strokeWidth="1.5" points={sparklinePoints(trend, 240, 36)} transform="translate(0,2)" />
            </svg>
            <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.8rem', color: '#475569', overflowWrap: 'anywhere' }}>
              <code>{finding.path}</code>
              {finding.detail ? ` · ${finding.detail}` : ''}
            </p>
          </>
        ) : null}
      </>
    );
  };

  const mutedText = { fontSize: '0.8rem', color: '#475569' } as const;
  const sectionHeading = { margin: '0.5rem 0 0.2rem 0', fontSize: '0.85rem', fontWeight: 700, color: '#334155' } as const;

  // An open line: what it is, since when, and the buttons on each open finding.
  const renderOpenLine = (line: IncidentLine, color: string) => (
    <li key={line.key} title={line.detail} style={{ color: '#0f172a' }}>
      <span aria-hidden="true" style={{ color }}>
        ⚠{' '}
      </span>
      <span style={{ fontWeight: 600 }}>{line.title}</span>
      <span style={mutedText}> – since {sinceText(line, now)}</span>
      <br />
      <span style={{ overflowWrap: 'anywhere' }}>{line.message}</span>
      {line.actions ? renderActions(line.findings[0]) : null}
      {line.actions ? renderTrend(line.findings[0], color) : null}
      {line.members.length > 0 ? (
        <details style={{ marginTop: '0.3rem' }}>
          <summary style={{ ...mutedText, cursor: 'pointer' }}>Each of the {line.members.length}: trend, mute or not useful</summary>
          <ul style={{ margin: '0.2rem 0 0 0', paddingLeft: '1.1rem', display: 'grid', gap: '0.3rem' }}>
            {line.members.map((member) => (
              <li key={member.key} title={member.detail}>
                <span style={{ fontWeight: 600 }}>{member.title}</span>
                {member.actions ? renderActions(member.findings[0]) : null}
                {member.actions ? renderTrend(member.findings[0], color) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );

  // A line that is back to normal: one short sentence, no buttons.
  const renderEarlierLine = (line: IncidentLine) => (
    <li key={line.key} title={line.detail} style={{ color: '#475569' }}>
      <span style={{ overflowWrap: 'anywhere' }}>{earlierLineText(line)}</span>
      {line.members.length > 0 ? (
        <details style={{ marginTop: '0.2rem' }}>
          <summary style={{ ...mutedText, cursor: 'pointer' }}>Each of the {line.members.length}</summary>
          <ul style={{ margin: '0.2rem 0 0 0', paddingLeft: '1.1rem' }}>
            {line.members.map((member) => (
              <li key={member.key} title={member.detail}>
                {earlierLineText(member)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );

  const renderIncident = (incident: WatchIncident) => {
    // Colour and headline are the engine's severity and title; the view only
    // orders and merges the findings under them.
    const style = SEVERITY_STYLE[incident.severity] ?? SEVERITY_STYLE.warn;
    const view = incidentView(incident);
    const showAll = showAllEarlier[incident.id] === true;
    const earlier = showAll ? view.earlier : view.earlier.slice(0, view.earlierShown);
    return (
      <article
        key={incident.id}
        style={{ padding: '0.65rem', borderRadius: '8px', background: style.background, border: `1px solid ${style.border}` }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <strong style={{ color: style.color }}>
            {incident.status === 'active' ? `${style.label}: ` : ''}
            {view.headline}
          </strong>
          <span style={mutedText}>
            started {formatClockTime(incident.openedAt)} · {formatAgo(incident.openedAt, now)}
          </span>
        </div>
        {view.open.length > 0 ? (
          <>
            <h4 style={sectionHeading}>Needs attention now</h4>
            <ul style={{ margin: 0, paddingLeft: '0.2rem', listStyle: 'none', display: 'grid', gap: '0.45rem' }}>
              {view.open.map((line) => renderOpenLine(line, style.color))}
            </ul>
          </>
        ) : null}
        {view.earlier.length > 0 || view.omitted ? (
          <>
            <h4 style={sectionHeading}>Earlier – all back to normal</h4>
            {view.omitted ? <p style={{ ...mutedText, margin: 0 }}>{view.omitted}, to keep the incident short.</p> : null}
            <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.2rem', fontSize: '0.9rem' }}>{earlier.map(renderEarlierLine)}</ul>
            {view.earlier.length > view.earlierShown ? (
              <button
                type="button"
                style={{ ...buttonStyle, marginTop: '0.3rem', padding: '0.15rem 0.5rem', fontSize: '0.8rem' }}
                onClick={() => setShowAllEarlier((previous) => ({ ...previous, [incident.id]: !showAll }))}
              >
                {showAll ? 'Show fewer' : `Show all ${view.earlier.length}`}
              </button>
            ) : null}
          </>
        ) : null}
        {incident.status === 'active' ? (
          <div style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              style={buttonStyle}
              title="Copies this incident as plain text, for the log or a message."
              onClick={() => copyFor(incident.id, incidentText(incident, now))}
            >
              {copied === incident.id ? 'Copied' : 'Copy as text'}
            </button>
          </div>
        ) : null}
      </article>
    );
  };

  const paths = status?.paths;
  const gnss = status?.gnss;
  const gnssLabel = gnss ? GNSS_LABEL[gnss.status] ?? GNSS_LABEL.unavailable : undefined;
  const latestRegime = status?.regimeChanges?.[0];

  return (
    <section
      style={{
        marginBottom: '1rem',
        padding: '0.75rem',
        borderRadius: '8px',
        backgroundColor: '#f8fafc',
        border: `1px solid ${activeIncidents.some((incident) => incident.severity === 'alert') ? '#fca5a5' : '#cbd5e1'}`
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Watchkeeper</h3>
        <span style={{ fontSize: '0.8rem', color: '#475569' }}>Statistical watch of every path · no language model</span>
      </div>

      {unreachable && status ? (
        // A poll that failed after earlier ones succeeded: the server went
        // away or the session expired. Shown whatever the last snapshot said -
        // on, off or busy - because none of it is current any more.
        <p style={{ margin: '0.5rem 0 0 0', color: '#b45309', fontWeight: 600 }}>
          Watch status could not be refreshed since {formatClockTime(updatedAt ?? undefined)}: what is shown below may be out of
          date.
        </p>
      ) : null}
      {unreachable && !status ? (
        <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>Watch status unavailable.</p>
      ) : !status ? (
        <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>Reading watch status…</p>
      ) : !status.enabled ? (
        <p style={{ margin: '0.5rem 0 0 0' }}>
          Off. Switch on <strong>Turn on Watchkeeper</strong> in the plugin settings to learn how this vessel
          normally behaves and be told when something departs from it. It runs on the CPU and needs no language model.
        </p>
      ) : (
        <>

          <p style={{ margin: '0.5rem 0 0 0' }}>
            {unreachable ? (
              <strong style={{ color: '#475569' }}>Status unknown.</strong>
            ) : activeIncidents.length === 0 ? (
              <strong style={{ color: '#166534' }}>Nothing unusual.</strong>
            ) : (
              <strong style={{ color: '#991b1b' }}>
                {activeIncidents.length} active incident{activeIncidents.length === 1 ? '' : 's'}.
              </strong>
            )}{' '}
            Watching {paths?.watched ?? 0} paths: {paths?.ready ?? 0} ready, {paths?.learning ?? 0} learning
            {paths && paths.relearning > 0 ? `, ${paths.relearning} re-learning` : ''}
            {paths && paths.excluded > 0 ? `; ${paths.excluded} skipped by design` : ''}
            {paths && paths.capped > 0 ? `; ${paths.capped} over the path limit` : ''}
            {status.sourcesCompared ? `; ${status.sourcesCompared} with redundant sources cross-checked` : ''}.
            {status.restoredBaseline ? ' Baseline restored from the last run.' : ''}
            <br />
            GNSS position: <span style={{ color: gnssLabel?.color }}>{gnssLabel?.text ?? 'unknown'}</span>
            {latestRegime ? (
              <>
                <br />
                Last operating change: {latestRegime.label} at {formatClockTime(latestRegime.at)} ({latestRegime.affected} paths
                re-learned)
              </>
            ) : null}
          </p>
          {status.lastError ? <p style={{ margin: '0.4rem 0 0 0', color: '#b45309' }}>{status.lastError}</p> : null}

          {activeIncidents.length > 0 ? (
            <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.6rem' }}>{activeIncidents.map(renderIncident)}</div>
          ) : null}

          <div style={{ marginTop: '0.6rem', padding: '0.6rem', borderRadius: '8px', background: '#ffffff', border: '1px solid #e2e8f0' }}>
            <p style={{ margin: 0, fontWeight: 600 }}>Your watches</p>
            {(status.rules ?? []).length === 0 ? (
              <p style={{ margin: '0.3rem 0 0 0', color: '#475569' }}>
                Add a limit of your own in plain words. Unusual values are already watched without one.
              </p>
            ) : (
              <ul style={{ margin: '0.3rem 0 0 0', paddingLeft: '1.1rem', display: 'grid', gap: '0.25rem' }}>
                {(status.rules ?? []).map((rule) => (
                  <li key={rule.id}>
                    <span style={{ color: rule.firing ? '#991b1b' : '#0f172a', fontWeight: rule.firing ? 700 : 400 }}>
                      {rule.firing ? 'Firing: ' : ''}
                      {rule.description}
                    </span>
                    {rule.current ? <span style={{ color: '#475569' }}> (now {rule.current})</span> : null}{' '}
                    <button type="button" style={{ ...buttonStyle, padding: '0.1rem 0.4rem' }} onClick={() => onDeleteRule(rule.id)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
              <input
                type="text"
                aria-label="New watch in plain words"
                placeholder="Tell me if the coolant goes above 95 for 2 minutes"
                value={ruleText}
                maxLength={300}
                onChange={(event: { target: { value: string } }) => {
                  compileGeneration.current += 1;
                  setRuleText(event.target.value);
                  setCompiled(null);
                }}
                onKeyDown={(event: { key: string }) => {
                  if (event.key === 'Enter') void onCompile();
                }}
                style={{ flex: '1 1 16rem', padding: '0.3rem 0.5rem', minWidth: 0 }}
              />
              <button type="button" style={buttonStyle} onClick={() => onCompile()} disabled={!ruleText.trim() || compiled === 'working'}>
                {compiled === 'working' ? 'Reading…' : 'Read it back'}
              </button>
            </div>
            {compiled && compiled !== 'working' ? (
              compiled.ok ? (
                <div style={{ marginTop: '0.4rem' }}>
                  <p style={{ margin: 0 }}>
                    <strong>{compiled.description}</strong>
                  </p>
                  {compiled.reading ? <p style={{ margin: '0.2rem 0 0 0', color: '#b45309', fontSize: '0.9rem' }}>{compiled.reading}</p> : null}
                  <p style={{ margin: '0.2rem 0 0 0', color: compiled.source === 'model' ? '#b45309' : '#475569', fontSize: '0.9rem' }}>
                    {compiled.source === 'model'
                      ? `Interpreted by ${compiled.model ?? 'the model'}: check the reading above before adding it.`
                      : 'Read by the built-in reader, without a model.'}{' '}
                    {describeCompileEvidence(compiled)}
                  </p>
                  <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem' }}>
                    <button type="button" style={buttonStyle} onClick={onAddRule}>
                      Add this watch
                    </button>
                    <button type="button" style={buttonStyle} onClick={() => setCompiled(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: '0.4rem' }}>
                  <p style={{ margin: 0, color: '#b45309' }}>{compiled.reason}</p>
                  {compiled.assistNote ? (
                    <p style={{ margin: '0.2rem 0 0 0', color: '#475569', fontSize: '0.9rem' }}>
                      {compiled.model ? `Also asked ${compiled.model}: ` : ''}
                      {compiled.assistNote}
                    </p>
                  ) : null}
                  {compiled.alternatives && compiled.alternatives.length > 0 ? (
                    <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
                      {compiled.alternatives.map((alternative) => (
                        <button
                          key={alternative.path}
                          type="button"
                          style={buttonStyle}
                          title={alternative.path}
                          onClick={() => onCompile(alternative.path)}
                        >
                          {alternative.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            ) : null}
          </div>

          {status.lessSensitive && status.lessSensitive.length > 0 ? (
            <p style={{ margin: '0.6rem 0 0 0', color: '#475569' }}>
              Less sensitive after your feedback:{' '}
              {status.lessSensitive.map((item) => (
                <span key={item.path} style={{ marginRight: '0.6rem' }}>
                  <code>{item.path}</code> (+{Math.round((item.factor - 1) * 100)} %){' '}
                  <button type="button" style={{ ...buttonStyle, padding: '0.1rem 0.4rem' }} onClick={() => onFeedback(item.path, 'reset')}>
                    Restore
                  </button>
                </span>
              ))}
            </p>
          ) : null}

          {status.mutes && status.mutes.length > 0 ? (
            <p style={{ margin: '0.6rem 0 0 0', color: '#475569' }}>
              Muted:{' '}
              {status.mutes.map((mute) => (
                <span key={mute.path} style={{ marginRight: '0.6rem' }}>
                  <code>{mute.path}</code> until {formatClockTime(mute.until)}{' '}
                  <button type="button" style={{ ...buttonStyle, padding: '0.1rem 0.4rem' }} onClick={() => onUnmute(mute.path)}>
                    Unmute
                  </button>
                </span>
              ))}
            </p>
          ) : null}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
            <button type="button" style={buttonStyle} onClick={() => setShowResolved((value) => !value)}>
              {showResolved ? 'Hide' : 'Show'} recent incidents ({resolvedIncidents.length})
            </button>
            <button type="button" style={buttonStyle} onClick={onReport}>
              {report && report !== 'loading' ? 'Hide report' : 'Watch report'}
            </button>
            <button type="button" style={buttonStyle} onClick={onUnusual}>
              {unusual && unusual !== 'loading' ? 'Hide unusual' : 'Most unusual now'}
            </button>
            <button type="button" style={buttonStyle} onClick={onInventory}>
              {inventory && inventory !== 'loading' ? 'Hide inventory' : 'What is watched?'}
            </button>
            <button type="button" style={buttonStyle} onClick={onReplay} disabled={replay === 'running'}>
              {replay === 'running' ? 'Replaying…' : 'Replay last 24 h'}
            </button>
          </div>
          {notice ? <p style={{ margin: '0.4rem 0 0 0', color: '#475569' }}>{notice}</p> : null}
          {manualCopy !== null ? (
            <div style={{ marginTop: '0.4rem' }}>
              <textarea
                key={manualCopyKey}
                readOnly
                autoFocus
                aria-label="Text to copy"
                value={manualCopy}
                rows={Math.min(12, manualCopy.split('\n').length + 1)}
                style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' }}
                onFocus={(event: { currentTarget: HTMLTextAreaElement }) => selectAll(event.currentTarget)}
                // The tap that follows focus on iOS (and a mouseup elsewhere)
                // moves the caret and undoes the selection: select again.
                onClick={(event: { currentTarget: HTMLTextAreaElement }) => selectAll(event.currentTarget)}
              />
              <button type="button" style={buttonStyle} onClick={closeManualCopy}>
                Done
              </button>
            </div>
          ) : null}

          {report === 'loading' ? <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>Writing the report…</p> : null}
          {report && report !== 'loading' && 'error' in report ? (
            <p style={{ margin: '0.5rem 0 0 0', color: '#b45309' }}>{report.error}</p>
          ) : null}
          {report && report !== 'loading' && !('error' in report) ? (
            <div style={{ marginTop: '0.5rem', padding: '0.6rem', borderRadius: '8px', background: '#ffffff', border: '1px solid #e2e8f0' }}>
              <p style={{ margin: 0, fontWeight: 600 }}>Last {report.hours} h</p>
              <ul style={{ margin: '0.3rem 0 0 0', paddingLeft: '1.1rem' }}>
                {report.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <button
                type="button"
                style={{ ...buttonStyle, marginTop: '0.4rem' }}
                onClick={() => copyFor('report', reportText(report))}
              >
                {copied === 'report' ? 'Copied' : 'Copy for the log'}
              </button>
            </div>
          ) : null}
          {unusual === 'loading' ? <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>Ranking…</p> : null}
          {unusual && unusual !== 'loading' && 'error' in unusual ? (
            <p style={{ margin: '0.5rem 0 0 0', color: '#b45309' }}>{unusual.error}</p>
          ) : null}
          {Array.isArray(unusual) ? (
            <div style={{ marginTop: '0.5rem', padding: '0.6rem', borderRadius: '8px', background: '#ffffff', border: '1px solid #e2e8f0' }}>
              {unusual.length === 0 ? (
                <p style={{ margin: 0 }}>Everything is within its usual range for the current operating state.</p>
              ) : (
                <>
                  <p style={{ margin: 0, color: '#475569' }}>
                    Furthest from their own normal right now, whether or not anything crossed a threshold:
                  </p>
                  <ol style={{ margin: '0.4rem 0 0 0', paddingLeft: '1.2rem' }}>
                    {unusual.map((row) => (
                      <li key={row.path}>
                        <span style={{ fontWeight: 600 }}>{row.title}</span>
                        <br />
                        <span style={{ overflowWrap: 'anywhere' }}>{row.message}</span>
                      </li>
                    ))}
                  </ol>
                  <button
                    type="button"
                    style={{ ...buttonStyle, marginTop: '0.4rem' }}
                    onClick={() => copyFor('unusual', unusualText(unusual))}
                  >
                    {copied === 'unusual' ? 'Copied' : 'Copy as text'}
                  </button>
                </>
              )}
            </div>
          ) : null}
          {inventory === 'loading' ? <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>Reading the inventory…</p> : null}
          {inventory && inventory !== 'loading' && 'error' in inventory ? (
            <p style={{ margin: '0.5rem 0 0 0', color: '#b45309' }}>{inventory.error}</p>
          ) : null}
          {inventory && inventory !== 'loading' && !('error' in inventory) ? (
            <div style={{ marginTop: '0.5rem', padding: '0.6rem', borderRadius: '8px', background: '#ffffff', border: '1px solid #e2e8f0' }}>
              <p style={{ margin: 0 }}>
                Found {inventory.totals.seen} paths on this vessel: {inventory.totals.watched} watched, {inventory.totals.skipped}{' '}
                skipped by design{inventory.totals.gnssInputs > 0 ? ` (${inventory.totals.gnssInputs} of them read by the GNSS check)` : ''}
                {inventory.totals.capped > 0 ? `, ${inventory.totals.capped} over the path limit` : ''}. Nothing is configured
                per boat: paths are picked up as they are published.
              </p>
              <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: 0, listStyle: 'none', display: 'grid', gap: '0.2rem' }}>
                {inventory.capabilities.map((capability) => (
                  <li key={capability.id}>
                    <span aria-hidden="true" style={{ color: capability.available ? '#166534' : '#94a3b8', fontWeight: 700 }}>
                      {capability.available ? '✓' : '–'}
                    </span>{' '}
                    <span style={{ fontWeight: 600 }}>{capability.label}</span>
                    <span style={{ color: '#475569' }}>: {capability.available ? capability.detail : `not available, ${capability.detail}`}</span>
                  </li>
                ))}
              </ul>
              <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>
                {inventory.branches.map((branch) => `${branch.branch} ${branch.watched}${branch.excluded ? ` (+${branch.excluded} skipped)` : ''}`).join(' · ')}
              </p>
              <input
                type="search"
                aria-label="Filter watched paths"
                placeholder="Filter paths"
                value={inventoryFilter}
                onChange={(event: { target: { value: string } }) => setInventoryFilter(event.target.value)}
                style={{ marginTop: '0.5rem', width: '100%', padding: '0.3rem 0.5rem', boxSizing: 'border-box' }}
              />
              <ul style={{ margin: '0.4rem 0 0 0', paddingLeft: '1.1rem', maxHeight: '18rem', overflow: 'auto' }}>
                {inventory.paths
                  .filter((row) => row.path.toLowerCase().includes(inventoryFilter.trim().toLowerCase()))
                  .slice(0, 300)
                  .map((row) => (
                    <li key={row.path} style={{ color: row.role === 'skipped' ? '#64748b' : '#0f172a' }}>
                      <code style={{ overflowWrap: 'anywhere' }}>{row.path}</code>{' '}
                      <span style={{ fontSize: '0.85rem', color: '#475569' }}>{describeInventoryRow(row)}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          {showResolved ? (
            resolvedIncidents.length === 0 ? (
              <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>No resolved incidents yet.</p>
            ) : (
              <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.1rem' }}>
                {resolvedIncidents.map((incident) => (
                  <li key={incident.id}>
                    <details>
                      <summary style={{ cursor: 'pointer' }}>
                        {formatClockTime(incident.openedAt)}–{formatClockTime(incident.resolvedAt)} {incident.title}
                        {incident.interrupted ? ' (plugin restarted)' : ''}
                      </summary>
                      <div style={{ marginTop: '0.3rem' }}>{renderIncident(incident)}</div>
                    </details>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {replay && replay !== 'running' ? (
            <div style={{ marginTop: '0.5rem', padding: '0.6rem', borderRadius: '8px', background: '#ffffff', border: '1px solid #e2e8f0' }}>
              {replay.ok ? (
                <>
                  <p style={{ margin: 0 }}>
                    Over the last 24 h of recorded history (
                    {typeof replay.pathsEvaluated === 'number' && replay.pathsEvaluated !== replay.pathsReplayed
                      ? `${replay.pathsEvaluated} of ${replay.pathsReplayed} paths had data`
                      : `${replay.pathsReplayed} paths`}
                    {replay.pathsSkipped ? `, ${replay.pathsSkipped} more not replayed` : ''}
                    {replay.pathsFailed ? `, ${replay.pathsFailed} could not be read` : ''}
                    {replay.truncated ? ', some rows left out' : ''}), this watch would have opened{' '}
                    <strong>{replay.incidentsOpened ?? 0}</strong> incident{replay.incidentsOpened === 1 ? '' : 's'} from{' '}
                    {replay.findingsOpened ?? 0} finding{replay.findingsOpened === 1 ? '' : 's'}: {describeDetectorCounts(replay.byDetector)}.
                  </p>
                  {replay.incidents && replay.incidents.length > 0 ? (
                    <ul style={{ margin: '0.4rem 0 0 0', paddingLeft: '1.1rem' }}>
                      {replay.incidents.slice(0, 8).map((incident) => (
                        <li key={incident.id}>
                          {new Date(incident.openedAt).toLocaleString()} {incident.title}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {replay.note ? <p style={{ margin: '0.4rem 0 0 0', color: '#475569', fontSize: '0.85rem' }}>{replay.note}</p> : null}
                </>
              ) : (
                <p style={{ margin: 0, color: '#b45309' }}>{replay.message}</p>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
