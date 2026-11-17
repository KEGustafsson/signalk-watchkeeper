/**
 * Watchkeeper types and the pure helpers behind the panel's Watch card.
 *
 * Kept free of React so they are unit-tested on their own: the incident
 * question in particular is what the operator sends to the model, and it has
 * to stay bounded and say plainly that the numbers in it were measured.
 */

export type WatchSeverity = 'warn' | 'alert';

export interface WatchFinding {
  readonly key: string;
  readonly detector: string;
  readonly path: string;
  readonly severity: WatchSeverity;
  readonly title: string;
  readonly message: string;
  readonly openedAt: number;
  readonly clearedAt?: number;
  readonly incidentId?: string;
  /** The exact figures behind the plain message (measured value, normal variations, rate), for the tooltip. */
  readonly detail?: string;
  /** A level's value and usual alone (`13.3 V, usually 13.8 V`), for a line about a departure that is over. */
  readonly brief?: string;
  /** `noData`, `stopped` (dropouts) or `switching` (cycling). */
  readonly kind?: string;
  /** The path as the owner would name it, and that name split into its system and what is measured on it. */
  readonly name?: string;
  readonly system?: string;
  readonly part?: string;
  /** Since when a dropout has been without data (the finding can open later, after a restart). */
  readonly since?: number;
}

export interface WatchIncident {
  readonly id: string;
  readonly status: 'active' | 'resolved';
  readonly openedAt: number;
  readonly updatedAt: number;
  readonly resolvedAt?: number;
  readonly interrupted?: boolean;
  /** The worst still open while active; once resolved, the worst it reached. */
  readonly severity: WatchSeverity;
  /** The worst it reached (absent from incidents saved by earlier versions). */
  readonly peakSeverity?: WatchSeverity;
  readonly title: string;
  readonly findings: readonly WatchFinding[];
  /** Earlier cleared findings dropped to keep the incident bounded. */
  readonly omitted?: number;
}

/** "3 earlier findings not shown", or '' when none were dropped. */
export function omittedText(incident: WatchIncident): string {
  const omitted = incident.omitted ?? 0;
  return omitted > 0 ? `${omitted} earlier finding${omitted === 1 ? '' : 's'} not shown` : '';
}

export interface WatchRegimeChange {
  readonly at: number;
  readonly label: string;
  readonly affected: number;
  readonly settleMs: number;
}

export interface WatchStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly usesLanguageModel?: boolean;
  readonly subscription?: string;
  readonly restoredBaseline?: boolean;
  readonly startedAt?: string;
  readonly lastError?: string;
  readonly sensitivity?: string;
  readonly learningMinutes?: number;
  readonly paths?: {
    readonly watched: number;
    readonly ready: number;
    readonly learning: number;
    readonly relearning: number;
    readonly excluded: number;
    readonly capped: number;
  };
  readonly sourcesCompared?: number;
  readonly activeFindings?: readonly WatchFinding[];
  readonly incidents?: readonly WatchIncident[];
  readonly regimeChanges?: readonly WatchRegimeChange[];
  readonly gnss?: {
    readonly status: 'ok' | 'degraded' | 'suspect' | 'lost' | 'unavailable';
    readonly indicators: Readonly<Record<string, 'ok' | 'active' | 'unavailable'>>;
  };
  readonly rules?: readonly WatchRuleStatus[];
  readonly lessSensitive?: ReadonlyArray<{ readonly path: string; readonly dismissals: number; readonly factor: number }>;
  readonly mutes?: ReadonlyArray<{ readonly path: string; readonly until: number }>;
}

export interface WatchInventoryRow {
  readonly path: string;
  readonly role: 'watching' | 'learning' | 'relearning' | 'skipped' | 'gnss-input';
  readonly kind?: string;
  readonly units?: string;
  readonly displayName?: string;
  readonly intervalMs?: number;
  readonly samples?: number;
  readonly excludedBy?: string;
  readonly sources?: ReadonlyArray<{ readonly name: string; readonly primary: boolean; readonly samples: number }>;
}

export interface WatchInventory {
  readonly totals: {
    readonly seen: number;
    readonly watched: number;
    readonly skipped: number;
    readonly capped: number;
    readonly gnssInputs: number;
    readonly multiSource: number;
  };
  readonly branches: ReadonlyArray<{ readonly branch: string; readonly watched: number; readonly excluded: number }>;
  readonly capabilities: ReadonlyArray<{ readonly id: string; readonly label: string; readonly available: boolean; readonly detail: string }>;
  readonly paths: readonly WatchInventoryRow[];
  readonly truncated?: number;
}

/** One inventory row in words: `watching · continuous · every 1 s · 2 sources (n2k.10 primary)`. */
export function describeInventoryRow(row: WatchInventoryRow): string {
  const parts: string[] = [];
  if (row.role === 'skipped') {
    parts.push(`skipped (${row.excludedBy ?? 'excluded'})`);
  } else if (row.role === 'gnss-input') {
    parts.push('read by the GNSS check');
  } else {
    parts.push(row.role === 'relearning' ? 're-learning' : row.role);
  }
  if (row.kind && row.kind !== 'unknown') parts.push(row.kind);
  if (typeof row.intervalMs === 'number') {
    parts.push(row.intervalMs < 1500 ? 'every 1 s' : row.intervalMs < 90000 ? `every ${Math.round(row.intervalMs / 1000)} s` : `every ${Math.round(row.intervalMs / 60000)} min`);
  }
  if (row.units) parts.push(row.units);
  const sources = row.sources ?? [];
  if (sources.length > 1) {
    const primary = sources.find((source) => source.primary);
    parts.push(`${sources.length} sources${primary ? ` (${primary.name} primary)` : ''}`);
  } else if (sources.length === 1 && sources[0].name !== 'default') {
    parts.push(sources[0].name);
  }
  return parts.join(' · ');
}

export interface WatchRuleCondition {
  readonly path: string;
  readonly op: 'above' | 'below' | 'atLeast' | 'atMost' | 'equals' | 'notEquals' | 'changes';
  readonly value?: number | string | boolean | null;
}

export interface WatchRule extends WatchRuleCondition {
  readonly id: string;
  readonly text: string;
  readonly forSeconds: number;
  readonly when?: WatchRuleCondition;
  readonly severity: WatchSeverity;
  readonly createdAt: number;
  readonly source: 'parser' | 'model' | 'manual';
}

export interface WatchRuleStatus extends WatchRule {
  readonly description: string;
  readonly firing: boolean;
  readonly current?: string;
}

export interface WatchRuleCompileResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly source?: 'parser' | 'model';
  readonly model?: string;
  readonly assist?: string;
  readonly assistNote?: string;
  readonly rule?: WatchRule;
  readonly description?: string;
  /** How the parser read a request that says what is normal, not when to alert. */
  readonly reading?: string;
  readonly current?: { readonly text: string };
  readonly wouldFireNow?: boolean | null;
  readonly recent?: { readonly minutes: number; readonly share: number };
  readonly alternatives?: ReadonlyArray<{ readonly path: string; readonly name: string }>;
}

/** A rule as stored: the status decorations stripped off. */
export function storedRule(rule: WatchRule): WatchRule {
  const { id, text, path, op, value, forSeconds, when, severity, createdAt, source } = rule;
  return { id, text, path, op, value, forSeconds, ...(when ? { when } : {}), severity, createdAt, source };
}

/** What the compile result means for the operator, in one line. */
export function describeCompileEvidence(result: WatchRuleCompileResult): string {
  const parts: string[] = [];
  if (result.current) {
    parts.push(`Now ${result.current.text}`);
  }
  if (result.wouldFireNow === true) {
    // The live watch also waits out the rule's duration, so "holds now" is
    // the honest reading; the description already says how long.
    parts.push('the condition holds now');
  } else if (result.wouldFireNow === false) {
    parts.push('the condition does not hold now');
  }
  if (result.recent && result.recent.minutes > 0) {
    parts.push(
      `true for ${Math.round(result.recent.share * 100)} % of the last ${result.recent.minutes} min the watch has recorded`
    );
  }
  return parts.length > 0 ? `${parts.join('; ')}.` : 'No data for this path has arrived yet.';
}

export interface WatchReport {
  readonly hours: number;
  readonly incidents: number;
  readonly findings: number;
  readonly lines: readonly string[];
}

/** The report as plain text, for the log or a message. */
export function reportText(report: WatchReport): string {
  return [`Watch report for the last ${report.hours} h:`, ...report.lines.map((line) => `- ${line}`)].join('\n');
}

export interface WatchUnusualRow {
  readonly path: string;
  readonly score: number;
  readonly title: string;
  readonly message: string;
}

/** The most unusual paths right now as plain text, most unusual first. */
export function unusualText(rows: readonly WatchUnusualRow[]): string {
  return [
    'Furthest from their own normal right now, most unusual first (they need not have raised an alarm):',
    ...rows.slice(0, 8).map((row) => `- ${row.title}: ${row.message}`)
  ].join('\n');
}

export interface WatchReplayResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly from?: string;
  readonly to?: string;
  readonly pathsReplayed?: number;
  readonly pathsEvaluated?: number;
  readonly pathsFailed?: number;
  readonly pathsSkipped?: number;
  readonly truncated?: boolean;
  readonly failures?: readonly string[];
  readonly findingsOpened?: number;
  readonly incidentsOpened?: number;
  readonly byDetector?: Readonly<Record<string, number>>;
  readonly incidents?: readonly WatchIncident[];
  readonly note?: string;
}

const MAX_TEXT_CHARS = 1800;

/** `14:05`, in the browser's local time. */
export function formatClockTime(at: number | undefined): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return '—';
  }
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** `3 min ago`, `2 h ago`. */
export function formatAgo(at: number | undefined, now: number = Date.now()): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return '';
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** `12 s`, `4 min`, `21 h`, `3 d`: a duration as an owner would say it. */
export function plainDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = ms / 1000;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `20:27` today, `yesterday 20:27`, `14 Nov 20:27` before that, in the browser's local time. */
export function formatSince(at: number | undefined, now: number = Date.now()): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
  const date = new Date(at);
  const today = new Date(now);
  const dayStart = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(date)) / (24 * 60 * 60 * 1000));
  const clock = formatClockTime(at);
  if (days <= 0) return clock;
  if (days === 1) return `yesterday ${clock}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
}

/**
 * One line of an incident as the panel and the copied text show it: a
 * finding, or several that started together and say the same kind of thing
 * (four systems switching state in the same minute, two readings of one
 * sensor with no data), merged with the findings themselves kept as
 * `members`.
 */
export interface IncidentLine {
  readonly key: string;
  readonly open: boolean;
  readonly severity: WatchSeverity;
  readonly title: string;
  readonly message: string;
  /** The message without how far out or how often, where there is one: the earlier lines use it. */
  readonly brief?: string;
  /** The exact figures, one line per finding. */
  readonly detail?: string;
  readonly openedAt: number;
  /** Since when it has been going on: the earliest of its findings. */
  readonly since: number;
  /** When it was back to normal: the last of its findings to clear. */
  readonly clearedAt?: number;
  /** Still open when a plugin restart closed its incident: never seen back to normal. */
  readonly closedByRestart?: boolean;
  readonly findings: readonly WatchFinding[];
  /** The single-finding lines it merges; empty for a line of one finding. */
  readonly members: readonly IncidentLine[];
  /** Trend, Mute and Not useful: only on one open finding of an active incident. */
  readonly actions: boolean;
}

export interface IncidentView {
  /**
   * What the incident is now: the engine's title while active, "All back to
   * normal at HH:MM" once resolved, or "Closed by a plugin restart at HH:MM"
   * when a restart closed it before its findings were seen to clear.
   */
  readonly headline: string;
  /** Open findings, most severe first: "Needs attention now". */
  readonly open: readonly IncidentLine[];
  /** Cleared findings, in the order they started: "Earlier – all back to normal". */
  readonly earlier: readonly IncidentLine[];
  /** "Earlier – all back to normal", or just "Earlier" when a restart closed some of them. */
  readonly earlierHeading: string;
  /** How many earlier lines show before "Show all"; all of them when there are only a few. */
  readonly earlierShown: number;
  readonly omitted: string;
}

/** Earlier lines shown before "Show all", when there are more than this. */
export const EARLIER_COLLAPSED = 5;

// Findings started within this of the first of a merged line are "at once".
const SAME_MOMENT_MS = 60 * 1000;
const SEVERITY_ORDER: Record<WatchSeverity, number> = { warn: 1, alert: 2 };

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `a`, `a and b`, `a, b and c`. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter((item) => item.length > 0))];
}

/** What a finding merges with, or undefined when it stands on its own. */
function mergeKey(finding: WatchFinding): string | undefined {
  // State switching: whichever systems, they flapped together.
  if (finding.detector === 'cycling') return 'switching';
  // No data, or no updates, from several readings of one system: one sensor.
  if (finding.detector === 'dropout' && finding.kind && finding.system) return `${finding.kind}:${finding.system}`;
  return undefined;
}

function nameOf(finding: WatchFinding): string {
  return finding.name ?? finding.path;
}

/** A finding as an incident's view holds it: marked when a restart, not recovery, closed it. */
type ViewFinding = WatchFinding & { readonly closedByRestart?: boolean };

function singleLine(finding: ViewFinding, active: boolean): IncidentLine {
  const open = finding.clearedAt === undefined;
  return {
    key: `${finding.key}-${finding.openedAt}`,
    open,
    severity: finding.severity,
    title: finding.title,
    message: finding.message,
    brief: finding.brief,
    detail: finding.detail,
    openedAt: finding.openedAt,
    since: typeof finding.since === 'number' && Number.isFinite(finding.since) ? Math.min(finding.since, finding.openedAt) : finding.openedAt,
    clearedAt: finding.clearedAt,
    closedByRestart: finding.closedByRestart === true,
    findings: [finding],
    members: [],
    actions: active && open
  };
}

function mergedLine(group: readonly WatchFinding[], active: boolean): IncidentLine {
  const members = group.map((finding) => singleLine(finding, active));
  if (members.length === 1) return members[0];
  const first = group[0];
  const open = members.every((member) => member.open);
  let title: string;
  let message: string;
  if (first.detector === 'cycling') {
    const systems = unique(group.map((finding) => finding.system ?? nameOf(finding)));
    title =
      systems.length > 1
        ? `Several systems switched state at once (${systems.join(', ')})`
        : `${capitalised(systems[0] ?? nameOf(first))}: ${group.length} states switched at once (${unique(group.map((finding) => finding.part ?? nameOf(finding))).join(', ')})`;
    message = first.message;
  } else {
    const parts = unique(group.map((finding) => finding.part ?? nameOf(finding)));
    const system = capitalised(first.system ?? nameOf(first));
    title = first.kind === 'noData' ? `${system} sensor sending no data` : `${system} sensor stopped updating`;
    message = `${capitalised(andList(parts))} ${first.kind === 'noData' ? 'are empty' : 'stopped'}. ${first.message}`;
  }
  return {
    key: members.map((member) => member.key).join('|'),
    open,
    severity: members.reduce<WatchSeverity>((worst, member) => (SEVERITY_ORDER[member.severity] > SEVERITY_ORDER[worst] ? member.severity : worst), 'warn'),
    title,
    message,
    detail: group.map((finding) => `${nameOf(finding)}: ${finding.detail ?? finding.message}`).join('\n'),
    openedAt: first.openedAt,
    since: Math.min(...members.map((member) => member.since)),
    clearedAt: open ? undefined : Math.max(...members.map((member) => member.clearedAt ?? member.openedAt)),
    closedByRestart: members.some((member) => member.closedByRestart),
    findings: group,
    members,
    actions: false
  };
}

/** Findings into lines: those that started together and say the same kind of thing merged. */
function linesOf(findings: readonly WatchFinding[], active: boolean): IncidentLine[] {
  const groups: { key?: string; findings: WatchFinding[] }[] = [];
  for (const finding of [...findings].sort((a, b) => a.openedAt - b.openedAt)) {
    const key = mergeKey(finding);
    const group = key === undefined ? undefined : groups.find((item) => item.key === key && finding.openedAt - item.findings[0].openedAt < SAME_MOMENT_MS);
    if (group) group.findings.push(finding);
    else groups.push({ key, findings: [finding] });
  }
  return groups.map((group) => mergedLine(group.findings, active));
}

/**
 * An incident as the owner reads it: what needs attention now, then what
 * happened earlier and is back to normal. The headline, and the severity the
 * panel colours it with, are the engine's: they are not worked out again
 * here.
 */
export function incidentView(incident: WatchIncident): IncidentView {
  const active = incident.status === 'active';
  // A resolved incident's findings are all over, whatever they say.
  const isOpen = (finding: WatchFinding) => active && finding.clearedAt === undefined;
  const open = linesOf(incident.findings.filter(isOpen), active).sort(
    (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.openedAt - b.openedAt
  );
  const closedAt = incident.resolvedAt ?? incident.updatedAt;
  // A restart that closed the incident closed its open findings at the
  // restart, as they were never seen to clear: they are not "back to normal".
  const interrupted = !active && incident.interrupted === true;
  const earlier = linesOf(
    incident.findings
      .filter((finding) => !isOpen(finding))
      .map((finding): ViewFinding => {
        const clearedAt = finding.clearedAt ?? closedAt;
        return interrupted && clearedAt === closedAt ? { ...finding, clearedAt, closedByRestart: true } : { ...finding, clearedAt };
      }),
    false
  );
  return {
    headline: active
      ? incident.title
      : interrupted
        ? `Closed by a plugin restart at ${formatClockTime(closedAt)}`
        : `All back to normal at ${formatClockTime(closedAt)}`,
    open,
    earlier,
    earlierHeading: earlier.some((line) => line.closedByRestart) ? 'Earlier' : 'Earlier – all back to normal',
    earlierShown: earlier.length > EARLIER_COLLAPSED + 1 ? EARLIER_COLLAPSED : earlier.length,
    omitted: omittedText(incident)
  };
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/[.;:,]+$/, '');
  return trimmed ? `${trimmed}.` : '';
}

/** `yesterday 20:27 (21 h)`: since when an open line has been going on, and for how long. */
export function sinceText(line: IncidentLine, now: number = Date.now()): string {
  const lasted = plainDuration(Math.max(0, now - line.since));
  return `${formatSince(line.since, now)}${lasted ? ` (${lasted})` : ''}`;
}

/** `Under-keel sensor sending no data – since yesterday 20:27 (21 h). Clearance and … are empty. …` */
export function openLineText(line: IncidentLine, now: number = Date.now()): string {
  return [`${line.title} – since ${sinceText(line, now)}.`, sentence(line.message)].filter(Boolean).join(' ');
}

/** `20:25 Victron DC-DC input voltage lower than usual: 13.3 V, usually 13.8 V. Normal again at 21:11.` */
export function earlierLineText(line: IncidentLine): string {
  const back = line.closedByRestart
    ? `Still open when the plugin restarted at ${formatClockTime(line.clearedAt)}.`
    : line.members.length > 0
      ? `All settled by ${formatClockTime(line.clearedAt)}.`
      : `Normal again at ${formatClockTime(line.clearedAt)}.`;
  const message = line.brief ?? line.message;
  return `${formatClockTime(line.openedAt)} ${line.title}${message ? `: ${sentence(message)}` : '.'} ${back}`;
}

/**
 * An incident as plain text, for the log or a message: what needs attention
 * now, then what is already back to normal, earliest first - the same lines
 * as the panel - and bounded however many findings it has.
 */
export function incidentText(incident: WatchIncident, now: number = Date.now()): string {
  const view = incidentView(incident);
  // Every line in order; `counted` ones are findings, which the overflow
  // notice counts when they do not fit.
  const lines: { text: string; counted: boolean }[] = [];
  if (view.open.length > 0) {
    lines.push({ text: 'Needs attention now:', counted: false });
    for (const line of view.open) lines.push({ text: `- ${openLineText(line, now)}`, counted: true });
  }
  if (view.earlier.length > 0 || view.omitted) {
    lines.push({ text: `${view.earlierHeading}:`, counted: false });
    // Findings dropped to keep the incident bounded still happened: said
    // first, as they were the earliest.
    if (view.omitted) lines.push({ text: `- (${view.omitted})`, counted: false });
    for (const line of view.earlier) lines.push({ text: `- ${earlierLineText(line)}`, counted: true });
  }
  const notice = (count: number) => `- …and ${count} more`;
  const out = [`Watchkeeper: ${view.headline}`.slice(0, MAX_TEXT_CHARS)];
  let used = out[0].length;
  let left = lines.filter((line) => line.counted).length;
  for (const line of lines) {
    const after = left - (line.counted ? 1 : 0);
    // Room for this line and its newline, and for the notice after it should
    // anything be left over.
    const needed = 1 + line.text.length + (after > 0 ? 1 + notice(after).length : 0);
    if (used + needed > MAX_TEXT_CHARS) {
      if (left > 0 && used + 1 + notice(left).length <= MAX_TEXT_CHARS) out.push(notice(left));
      break;
    }
    out.push(line.text);
    used += 1 + line.text.length;
    left = after;
  }
  return out.join('\n');
}

/** SVG polyline points for a sparkline of `[t, v]` pairs in a width×height box. */
export function sparklinePoints(series: ReadonlyArray<readonly [number, number]>, width: number, height: number): string {
  const points = series.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  if (points.length < 2) {
    return '';
  }
  let minT = Infinity;
  let maxT = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [t, v] of points) {
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const spanT = maxT - minT || 1;
  const spanV = maxV - minV || 1;
  return points
    .map(([t, v]) => {
      const x = ((t - minT) / spanT) * width;
      const y = height - ((v - minV) / spanV) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** `shift 3, dropout 1`: a replay's findings by detector, in plain words. */
export function describeDetectorCounts(byDetector: Readonly<Record<string, number>> | undefined): string {
  const labels: Record<string, string> = {
    shift: 'unusual level',
    rate: 'counting fast',
    dropout: 'stopped updating',
    frozen: 'stuck sensor',
    newState: 'new state',
    cycling: 'cycling',
    forecast: 'trend toward a limit',
    feed: 'data feed silent',
    disagree: 'sources disagree',
    failover: 'source failover'
  };
  const entries = Object.entries(byDetector ?? {}).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    return 'nothing';
  }
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([detector, count]) => `${count} ${labels[detector] ?? (detector.startsWith('gnss.') ? `GNSS ${detector.slice(5)}` : detector)}`)
    .join(', ');
}

/**
 * Orders overlapping requests: `begin()` numbers each one as it is sent,
 * `accept(turn)` says whether its answer is newer than every answer already
 * taken. A poll that took longer than the next one cannot put an older
 * snapshot back over a newer one.
 */
export function createLatestGate(): { begin(): number; accept(turn: number): boolean } {
  let sent = 0;
  let accepted = 0;
  return {
    begin: () => {
      sent += 1;
      return sent;
    },
    accept: (turn: number) => {
      if (turn <= accepted) return false;
      accepted = turn;
      return true;
    }
  };
}
