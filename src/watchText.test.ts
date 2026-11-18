import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EARLIER_COLLAPSED,
  createLatestGate,
  earlierLineText,
  formatClockTime,
  formatSince,
  incidentText,
  incidentView,
  omittedText,
  openLineText,
  plainDuration,
  reportText,
  unusualText,
  describeCompileEvidence,
  describeDetectorCounts,
  storedRule,
  describeInventoryRow,
  formatAgo,
  sparklinePoints
} from './watchText.js';
import type { WatchFinding, WatchIncident } from './watchText.js';

const incident: WatchIncident = {
  id: 'inc-1',
  status: 'active',
  openedAt: Date.UTC(2026, 5, 1, 8, 0),
  updatedAt: Date.UTC(2026, 5, 1, 8, 5),
  severity: 'alert',
  title: 'Main engine temperature higher than usual (+1 related)',
  findings: [
    {
      key: 'shift:propulsion.main.temperature',
      detector: 'shift',
      path: 'propulsion.main.temperature',
      severity: 'alert',
      title: 'Main engine temperature higher than usual',
      message: '92 °C, usually 81 °C – clearly outside its normal range',
      detail: '92.0 °C, +11.2 °C from its usual 80.8 °C (7.4× its normal variation)',
      openedAt: Date.UTC(2026, 5, 1, 8, 0)
    },
    {
      key: 'shift:electrical.alternators.main.current',
      detector: 'shift',
      path: 'electrical.alternators.main.current',
      severity: 'warn',
      title: 'Main alternator current lower than usual',
      message: '2 A, usually 32 A – far outside its normal range',
      brief: '2 A, usually 32 A',
      openedAt: Date.UTC(2026, 5, 1, 8, 3),
      clearedAt: Date.UTC(2026, 5, 1, 8, 5)
    }
  ]
};

// The incident the owner looked at and found "not informative or easy to
// read", in the engine's new wording: 18 findings over a day, three open.
const at = (day: number, hour: number, minute: number, second = 0) => new Date(2026, 10, day, hour, minute, second).getTime();
const NOW = at(17, 17, 0);

function finding(
  path: string,
  detector: string,
  title: string,
  message: string,
  openedAt: number,
  extra: Partial<WatchFinding> = {}
): WatchFinding {
  // A level's brief is its value and usual, as narrate.cjs gives it.
  const brief = detector === 'shift' ? { brief: message.split(' – ')[0] } : {};
  return { key: `${detector}:${path}`, detector, path, severity: 'warn', title, message, openedAt, ...brief, ...extra };
}

const switching = (path: string, name: string, system: string, openedAt: number, clearedAt?: number) =>
  finding(path, 'cycling', `${name} switching unusually often`, '4 switches in the last hour, normally under 1 an hour', openedAt, {
    kind: 'switching',
    name,
    system,
    detail: '4 changes in the last hour, against about 0.3 per hour normally',
    ...(clearedAt === undefined ? {} : { clearedAt })
  });

const OWNER: WatchIncident = {
  id: 'inc-owner',
  status: 'active',
  openedAt: at(16, 20, 25),
  updatedAt: NOW,
  severity: 'alert',
  // The engine's title; the panel shows it as it is.
  title: 'Under-keel clearance sending no data (+17 related)',
  findings: [
    switching('navigation.underKeel.state', 'Under-keel state', 'under-keel', at(16, 20, 25, 0), at(16, 22, 34)),
    switching('control.remoteController.plugin.hhLive', 'Remote controller plugin hh live', 'remote controller', at(16, 20, 25, 10), at(16, 21, 24)),
    switching('vision.system.attitudeCompensated', 'Vision system attitude compensated', 'vision', at(16, 20, 25, 20), at(16, 21, 24)),
    switching('control.remoteController.hhLinkUp', 'Remote controller hh link up', 'remote controller', at(16, 20, 25, 30), at(16, 21, 24)),
    switching('sensors.headingHold.gnssValid', 'Heading hold GNSS valid', 'heading hold', at(16, 20, 25, 40), at(16, 21, 24)),
    finding('environment.nano.memoryUtilisation', 'shift', 'Nano memory use higher than usual', '87 %, usually 72 % – clearly outside its normal range', at(16, 20, 25, 45), {
      clearedAt: at(16, 20, 39),
      detail: '0.870, +0.152 from its usual 0.718 (7.6× its normal variation)'
    }),
    finding('electrical.victron.dcdc.voltageIn', 'shift', 'Victron DC-DC input voltage lower than usual', '13.3 V, usually 13.8 V – far outside its normal range', at(16, 20, 25, 50), {
      severity: 'alert',
      clearedAt: at(16, 21, 11),
      detail: '13.30 V, −0.54 V from its usual 13.84 V (10.8× its normal variation)'
    }),
    finding('navigation.underKeel.clearance', 'dropout', 'Under-keel clearance sending no data', 'It normally updates every 10 s (source signalk-underkeel)', at(16, 20, 27), {
      severity: 'alert',
      kind: 'noData',
      name: 'Under-keel clearance',
      system: 'under-keel',
      part: 'clearance',
      since: at(16, 20, 25),
      detail: 'No reading for 20.6 h: the sensor is sending "no value" (null); it normally updates every 10 s (source signalk-underkeel)'
    }),
    finding('navigation.underKeel.escapeHeading', 'dropout', 'Under-keel escape heading sending no data', 'It normally updates every 10 s (source signalk-underkeel)', at(16, 20, 27, 5), {
      severity: 'alert',
      kind: 'noData',
      name: 'Under-keel escape heading',
      system: 'under-keel',
      part: 'escape heading',
      since: at(16, 20, 25)
    }),
    finding('vision.system.inferenceFps', 'shift', 'Vision system inference frames/s lower than usual', '12.0 frames/s, usually 12.1 frames/s – a little outside its normal range', at(16, 21, 32), {
      clearedAt: at(16, 21, 33),
      detail: '11.96 Hz, −2.55 Hz from its usual 12.09 Hz (4.0× its normal variation), changing −3.79 Hz/min'
    }),
    finding('environment.nano.sdUtilisation', 'shift', 'Nano SD card use higher than usual', '30 %, usually 29 % – clearly outside its normal range', at(17, 0, 25), { clearedAt: at(17, 1, 26) }),
    finding('environment.nano.memoryUtilisation', 'shift', 'Nano memory use lower than usual', '72 %, usually 79 % – a little outside its normal range', at(17, 6, 50), { key: 'shift:mem-2', clearedAt: at(17, 7, 7) }),
    finding('environment.nano.cpuTemperature', 'shift', 'Nano CPU temperature higher than usual', '53 °C, usually 51 °C – a little outside its normal range', at(17, 9, 10), { key: 'cpu-1', clearedAt: at(17, 9, 20) }),
    finding('environment.nano.cpuTemperature', 'shift', 'Nano CPU temperature higher than usual', '53 °C, usually 51 °C – a little outside its normal range', at(17, 11, 0), { key: 'cpu-2', clearedAt: at(17, 11, 11) }),
    finding(
      'environment.nano.cpuTemperature',
      'shift',
      'Nano CPU temperature higher than usual',
      '53 °C, usually 51 °C – a little outside its normal range. It has risen like this 8 times in the past 15 h, for up to 11 min each; this one is no bigger than those',
      at(17, 15, 40),
      { key: 'cpu-3', detail: '53.4 °C, +2.7 °C from its usual 50.7 °C (3.6× its normal variation)' }
    ),
    finding('navigation.underKeel.state', 'newState', 'Under-keel state now reads "unknown"', 'Before only "alarm" or "off"', at(17, 16, 0), { key: 'newState:uk' }),
    switching('navigation.underKeel.state', 'Under-keel state', 'under-keel', at(17, 16, 5, 0)),
    switching('control.remoteController.plugin.hhLive', 'Remote controller plugin hh live', 'remote controller', at(17, 16, 5, 20))
  ]
};

describe('incidentView: the owner\'s incident', () => {
  const view = incidentView(OWNER);

  it('puts what needs attention now first, most severe first, and what is back to normal after', () => {
    assert.equal(view.headline, OWNER.title, 'the headline is the engine\'s title');
    assert.deepEqual(
      view.open.map((line) => line.title),
      [
        'Under-keel sensor sending no data',
        'Nano CPU temperature higher than usual',
        'Under-keel state now reads "unknown"',
        'Several systems switched state at once (under-keel, remote controller)'
      ]
    );
    assert.ok(view.open.every((line) => line.open));
    assert.ok(view.earlier.every((line) => !line.open && line.clearedAt !== undefined));
    assert.deepEqual(
      view.earlier.map((line) => formatClockTime(line.openedAt)),
      ['20:25', '20:25', '20:25', '21:32', '00:25', '06:50', '09:10', '11:00'],
      'earlier lines in the order they started'
    );
  });

  it('merges the systems that switched state in the same minute into one line, keeping each finding', () => {
    const burst = view.earlier[0];
    assert.equal(burst.title, 'Several systems switched state at once (under-keel, remote controller, vision, heading hold)');
    assert.equal(burst.members.length, 5);
    assert.equal(formatClockTime(burst.clearedAt), '22:34', 'settled when the last of them did');
    assert.equal(
      earlierLineText(burst),
      '20:25 Several systems switched state at once (under-keel, remote controller, vision, heading hold): 4 switches in the last hour, normally under 1 an hour. All settled by 22:34.'
    );
  });

  it('puts the readings of one sensor with no data on one line, since the data stopped', () => {
    const sensor = view.open[0];
    assert.equal(sensor.members.length, 2);
    assert.equal(
      openLineText(sensor, NOW),
      'Under-keel sensor sending no data – since yesterday 20:25 (21 h). Clearance and escape heading are empty. It normally updates every 10 s (source signalk-underkeel).'
    );
  });

  it('shows the buttons only on open findings', () => {
    const lines = [...view.open, ...view.earlier];
    const singles = lines.flatMap((line) => (line.members.length > 0 ? line.members : [line]));
    assert.ok(singles.filter((line) => line.open).every((line) => line.actions), 'every open finding has its buttons');
    assert.ok(singles.filter((line) => !line.open).every((line) => !line.actions), 'no cleared finding has them');
    assert.ok(lines.filter((line) => line.members.length > 0).every((line) => !line.actions), 'a merged line has them on its findings');
    const resolved = incidentView({ ...OWNER, status: 'resolved', resolvedAt: at(17, 18, 2), findings: OWNER.findings.map((item) => ({ ...item, clearedAt: item.clearedAt ?? at(17, 18, 2) })) });
    assert.equal(resolved.headline, 'All back to normal at 18:02');
    assert.equal(resolved.open.length, 0);
    assert.ok(resolved.earlier.every((line) => !line.actions && line.members.every((member) => !member.actions)));
  });

  it('collapses a long list of earlier lines', () => {
    assert.equal(view.earlier.length, 8);
    assert.equal(view.earlierShown, EARLIER_COLLAPSED);
    assert.equal(incidentView({ ...OWNER, findings: OWNER.findings.slice(0, 9) }).earlierShown, 3, 'a short list shows whole');
  });

  it('copies as the same plain text, with nothing about normal variations', () => {
    const text = incidentText(OWNER, NOW);
    const lines = text.split('\n');
    assert.equal(lines[0], `Watchkeeper: ${OWNER.title}`);
    assert.equal(lines[1], 'Needs attention now:');
    assert.match(lines[2], /^- Under-keel sensor sending no data – since yesterday 20:25 \(21 h\)\./);
    assert.match(lines[3], /^- Nano CPU temperature higher than usual – since 15:40 \(80 min\)\. 53 °C, usually 51 °C/);
    assert.equal(lines[6], 'Earlier – all back to normal:');
    assert.match(text, /\n- 20:25 Victron DC-DC input voltage lower than usual: 13\.3 V, usually 13\.8 V\. Normal again at 21:11\.\n/);
    assert.match(text, /\n- 00:25 Nano SD card use higher than usual: 30 %, usually 29 %\. Normal again at 01:26\.\n/);
    assert.match(text, /\n- 20:25 Nano memory use higher than usual: 87 %, usually 72 %\. Normal again at 20:39\.\n/);
    assert.doesNotMatch(text, /…and \d+ more/, 'the whole incident fits');
    assert.doesNotMatch(text, /normal variation|from its usual|×|first sign/);
    assert.ok(text.indexOf('Needs attention now') < text.indexOf('Earlier – all back to normal'));
  });
});

describe('incidentText', () => {
  it('says what needs attention, then what is back to normal', () => {
    const lines = incidentText(incident, Date.UTC(2026, 5, 1, 8, 10)).split('\n');
    assert.equal(lines[0], 'Watchkeeper: Main engine temperature higher than usual (+1 related)');
    assert.equal(lines[1], 'Needs attention now:');
    assert.match(lines[2], /^- Main engine temperature higher than usual – since \d\d:00 \(10 min\)\. 92 °C, usually 81 °C/);
    assert.equal(lines[3], 'Earlier – all back to normal:');
    assert.match(lines[4], /^- \d\d:03 Main alternator current lower than usual: 2 A, usually 32 A\. Normal again at \d\d:05\.$/);
    assert.equal(lines.length, 5);
  });

  it('stays bounded however many findings an incident has', () => {
    const many: WatchIncident = {
      ...incident,
      findings: Array.from({ length: 80 }, (_, index) => ({ ...incident.findings[0], key: `k${index}`, path: `a.b${index}` }))
    };
    const text = incidentText(many);
    assert.ok(text.length <= 1800);
    assert.match(text, /…and \d+ more/);
  });

  it('keeps its separators and the notice of what is left inside the limit', () => {
    // Lines of every length, so that one of them ends the text right at the
    // limit with findings still to count.
    for (let pad = 0; pad < 60; pad += 1) {
      const many: WatchIncident = {
        ...incident,
        findings: Array.from({ length: 40 }, (_, index) => ({
          ...incident.findings[0],
          key: `k${index}`,
          path: `a.b${index}`,
          message: `${'x'.repeat(pad + (index % 7))} reading`
        }))
      };
      const text = incidentText(many, Date.UTC(2026, 5, 1, 8, 10));
      assert.ok(text.length <= 1800, `${text.length} characters with padding ${pad}`);
      const counted = text.split('\n').filter((line) => line.startsWith('- ') && !line.startsWith('- …')).length;
      const more = /…and (\d+) more$/.exec(text);
      assert.ok(more !== null, 'says what was left out');
      assert.equal(counted + Number(more?.[1]), 40);
    }
  });

  it('still says how many findings were left out when the title is very long', () => {
    const text = incidentText({ ...incident, title: 'T'.repeat(3000) }, Date.UTC(2026, 5, 1, 8, 10));
    assert.ok(text.length <= 1800, `${text.length} characters`);
    assert.match(text, /\n- …and 2 more$/);
  });

  it('counts findings, not lines, in what was left out', () => {
    const long = 'T'.repeat(3000);
    // Two switching findings merged into one line, and three findings the
    // engine already dropped: all five are left out.
    const switching = (key: string, system: string): WatchFinding => ({
      ...incident.findings[0],
      key,
      path: `${system}.state`,
      detector: 'cycling',
      kind: 'switching',
      system,
      title: `${system} switching unusually often`,
      openedAt: Date.UTC(2026, 5, 1, 8, 0)
    });
    const text = incidentText(
      { ...incident, title: long, omitted: 3, findings: [switching('a', 'Vision'), switching('b', 'Heading hold')] },
      Date.UTC(2026, 5, 1, 8, 10)
    );
    assert.ok(text.length <= 1800, `${text.length} characters`);
    assert.match(text, /\n- …and 5 more$/);
  });

  it('does not call findings a restart closed back to normal', () => {
    const restartAt = Date.UTC(2026, 5, 1, 9, 0);
    const closed: WatchIncident = {
      ...incident,
      status: 'resolved',
      resolvedAt: restartAt,
      interrupted: true,
      // The restart closed the open finding at the restart; the other had
      // recovered on its own before.
      findings: incident.findings.map((finding) => ({ ...finding, clearedAt: finding.clearedAt ?? restartAt }))
    };
    const view = incidentView(closed);
    assert.match(view.headline, /^Closed by a plugin restart at \d\d:00$/);
    assert.equal(view.earlierHeading, 'Earlier');
    const text = incidentText(closed);
    assert.doesNotMatch(text, /All back to normal/);
    assert.match(text, /Main engine temperature higher than usual: .*Still open when the plugin restarted at \d\d:00\.$/m);
    assert.match(text, /Main alternator current lower than usual: .*Normal again at \d\d:05\.$/m);
    // One finding a restart closed, in an incident that otherwise recovered.
    const part = incidentView({
      ...closed,
      interrupted: false,
      findings: [
        { ...closed.findings[0], clearedAt: Date.UTC(2026, 5, 1, 8, 30), closedByRestart: true },
        { ...closed.findings[1], clearedAt: Date.UTC(2026, 5, 1, 8, 5) }
      ]
    });
    assert.match(part.headline, /^Over at \d\d:00; a plugin restart closed part of it$/);
    assert.equal(part.earlierHeading, 'Earlier');
    assert.match(earlierLineText(part.earlier[0]), /Still open when the plugin restarted at \d\d:30\.$/);
    assert.match(earlierLineText(part.earlier[1]), /Normal again at \d\d:05\.$/);
    // Merged: one switching finding closed by the restart at 09:00, another
    // of the same burst seen to settle at 09:30.
    const switching = (key: string, system: string, clearedAt: number, closedByRestart?: boolean): WatchFinding => ({
      ...closed.findings[0],
      key,
      path: `${system}.state`,
      detector: 'cycling',
      kind: 'switching',
      system,
      title: `${system} switching unusually often`,
      message: '4 switches in the last hour, normally under 1 an hour',
      brief: undefined,
      openedAt: Date.UTC(2026, 5, 1, 8, 0),
      clearedAt,
      closedByRestart
    });
    const burst = incidentView({
      ...closed,
      interrupted: false,
      resolvedAt: Date.UTC(2026, 5, 1, 9, 30),
      findings: [switching('a', 'Vision', Date.UTC(2026, 5, 1, 9, 0), true), switching('b', 'Heading hold', Date.UTC(2026, 5, 1, 9, 30))]
    });
    assert.equal(burst.earlier.length, 1);
    assert.match(
      earlierLineText(burst.earlier[0]),
      /Settled by \d\d:30, apart from what was still open when the plugin restarted at \d\d:00\.$/
    );
    // Resolved on its own: back to normal, as before.
    const recovered = incidentView({ ...closed, interrupted: false });
    assert.match(recovered.headline, /^All back to normal at /);
    assert.equal(recovered.earlierHeading, 'Earlier – all back to normal');
  });

  it('says how many earlier findings were dropped to keep it bounded', () => {
    const lines = incidentText({ ...incident, omitted: 3 }).split('\n');
    assert.match(lines[2], /temperature higher than usual/, 'what needs attention stays first');
    assert.equal(lines[4], '- (3 earlier findings not shown)');
    assert.equal(lines.length, 6);
    assert.ok(!incidentText({ ...incident, omitted: 0 }).includes('not shown'));
    assert.equal(omittedText({ ...incident, omitted: 1 }), '1 earlier finding not shown');
  });
});

describe('when and how long', () => {
  it('says since when in plain words', () => {
    assert.equal(formatSince(at(17, 9, 5), NOW), '09:05');
    assert.equal(formatSince(at(16, 20, 27), NOW), 'yesterday 20:27');
    assert.equal(formatSince(at(14, 8, 0), NOW), '14 Nov 08:00');
    assert.equal(plainDuration(20.6 * 60 * 60 * 1000), '21 h');
    assert.equal(plainDuration(47 * 60 * 1000), '47 min');
  });
});

describe('watch panel helpers', () => {
  it('draws a sparkline inside its box', () => {
    const points = sparklinePoints([[0, 1], [10, 3], [20, 2]], 100, 20).split(' ');
    assert.deepEqual(points, ['0.0,20.0', '50.0,0.0', '100.0,10.0']);
    assert.equal(sparklinePoints([[0, 1]], 100, 20), '');
  });

  it('describes replay counts in words, biggest first', () => {
    assert.equal(describeDetectorCounts({ dropout: 1, shift: 3, 'gnss.jump': 2 }), '3 unusual level, 2 GNSS jump, 1 stopped updating');
    assert.equal(describeDetectorCounts({}), 'nothing');
  });

  it('says how long ago', () => {
    assert.equal(formatAgo(1000, 1000 + 30 * 1000), 'just now');
    assert.equal(formatAgo(0, 5 * 60 * 1000), '5 min ago');
    assert.equal(formatAgo(0, 3 * 60 * 60 * 1000), '3 h ago');
  });
});

describe('describeInventoryRow', () => {
  it('says what the watch does with a path, and why', () => {
    assert.equal(
      describeInventoryRow({
        path: 'environment.water.temperature',
        role: 'watching',
        kind: 'continuous',
        intervalMs: 1000,
        units: 'K',
        sources: [
          { name: 'n2k.10', primary: true, samples: 10 },
          { name: 'n2k.20', primary: false, samples: 10 }
        ]
      }),
      'watching · continuous · every 1 s · K · 2 sources (n2k.10 primary)'
    );
    assert.equal(
      describeInventoryRow({ path: 'navigation.headingTrue', role: 'gnss-input', excludedBy: 'navigation.heading*' }),
      'read by the GNSS check'
    );
    assert.equal(
      describeInventoryRow({ path: 'environment.wind.speedApparent', role: 'skipped', excludedBy: 'environment.wind' }),
      'skipped (environment.wind)'
    );
  });
});

describe('unusualText', () => {
  it('lists the most unusual paths, without claiming that nothing raised an alarm', () => {
    const text = unusualText([
      { path: 'a', score: 3.1, title: 'House battery voltage somewhat lower than usual', message: '13.03 V, usually 13.20 V – a little outside its normal range' }
    ]);
    assert.match(text, /House battery voltage somewhat lower than usual: 13\.03 V/);
    assert.ok(!/Nothing has raised an alarm/.test(text));
  });
});

describe('watch rules in the panel', () => {
  it('summarises the evidence for a rule before it is added', () => {
    assert.equal(
      describeCompileEvidence({ ok: true, current: { text: '79.9 °C' }, wouldFireNow: false, recent: { minutes: 90, share: 0 } }),
      'Now 79.9 °C; the condition does not hold now; true for 0 % of the last 90 min the watch has recorded.'
    );
    assert.equal(describeCompileEvidence({ ok: true }), 'No data for this path has arrived yet.');
  });

  it('stores a rule without its status decorations', () => {
    const stored = storedRule({
      id: 'r-1', text: 't', path: 'a.b', op: 'above', value: 1, forSeconds: 0, severity: 'warn', createdAt: 1, source: 'parser',
      description: 'x', firing: true, current: '1'
    } as never);
    assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'forSeconds', 'id', 'op', 'path', 'severity', 'source', 'text', 'value']);
  });
});

describe('reportText', () => {
  it('lists the measured lines under the window', () => {
    const text = reportText({ hours: 24, incidents: 1, findings: 2, lines: ['1 incident (0 alerts, 1 warning) from 2 findings.'] });
    assert.equal(text, 'Watch report for the last 24 h:\n- 1 incident (0 alerts, 1 warning) from 2 findings.');
  });
});

describe('createLatestGate', () => {
  it('takes an answer only when it is newer than every answer taken', () => {
    const gate = createLatestGate();
    const first = gate.begin();
    const second = gate.begin();
    // The second poll answers first; the first one, slower, comes after.
    assert.equal(gate.accept(second), true);
    assert.equal(gate.accept(first), false, 'an older poll does not replace a newer one');
    const third = gate.begin();
    assert.equal(gate.accept(third), true);
  });
});
