# Watchkeeper reference

Watchkeeper is a background watch of every Signal K path. It learns how each
of this vessel's paths normally behaves and raises a Signal K notification
when one departs from it.

This page is the reference: how it works, every check and its thresholds, the
rule format, the HTTP API, and how to tune it. For a short introduction see the
[README](../README.md).

> Watchkeeper is experimental. It adds detection for things nobody set a
> threshold for. It does not replace the alarms already on the boat, and it is
> not a safety-critical system.

## Contents

- [Design in one paragraph](#design-in-one-paragraph)
- [Pipeline](#pipeline)
- [Discovery](#discovery)
- [Per-path learning](#per-path-learning)
- [Checks](#checks)
- [GNSS integrity](#gnss-integrity)
- [Redundant sources](#redundant-sources)
- [Operating states](#operating-states)
- [Habits](#habits)
- [Findings, incidents and notifications](#findings-incidents-and-notifications)
- [Your own watches (rules)](#your-own-watches-rules)
- [Feedback and the watch report](#feedback-and-the-watch-report)
- [Where the language model is and is not used](#where-the-language-model-is-and-is-not-used)
- [HTTP API](#http-api)
- [Settings](#settings)
- [Replay and the History API](#replay-and-the-history-api)
- [Persistence](#persistence)
- [Measuring it on your own data](#measuring-it-on-your-own-data)
- [Tuning](#tuning)
- [Performance](#performance)
- [Limitations](#limitations)
- [Source map](#source-map)

## Design in one paragraph

Detection is statistics, not a language model. A small model cannot hold a
whole vessel's data in its context window, a scan would cost tens of seconds of
GPU time, and it would sometimes invent things. So every check is a small,
deterministic, O(1)-per-update computation on the CPU, and every message is a
template filled with the numbers the check measured. A model is only involved
when the operator configures one, and then only to read a plain-language watch
rule that the built-in parser could not read.

## Pipeline

```
Signal K deltas (vessels.self, every path, ≤ 1 Hz per path)
  │
  ├─ operating-state gates ──► re-learn / restore per-state baselines
  ├─ exclusions ─────────────► skipped (still: latest value, source comparison)
  ├─ GNSS inputs ────────────► GNSS integrity monitor
  └─ watched paths
       ├─ source routing ────► primary feeds the baseline, others are compared
       └─ path monitor ──────► learned baseline, series, discrete states
                                    │
every 5 s:  checks ─► tracker (persistence, hysteresis) ─► findings
                                                                │
                              incidents ◄────────────────────────┤
                              notifications.watchkeeper.* ◄──────┘
```

The engine (`lib/watch/engine.cjs`) has no clock and no I/O: the caller
passes the time with every call. The same engine therefore runs live in the
plugin, over a day of History API data in a replay, and in the unit tests, and
gives the same answers in all three.

## Discovery

Nothing is configured per boat. The watch subscribes to `*` on `vessels.self`
(through the subscription manager, or the stream bundle on servers without
one) and picks up each path when it is first published, whether it is a
standard Signal K path or a plugin's own.

- **Object values** (attitude, a nested sensor) are split into their leaves, to
  a depth of 3 and at most 32 leaves per value.
- **`null` is "no value".** Signal K sends `null` when a sensor has nothing
  to report (a Bluetooth sensor out of range, a charger reconnecting). It is
  never a state of the path and never a sample: a path that briefly sends
  `null` is not reported at all, and one that keeps sending it is reported
  as having no value once it has been silent for its dropout limit, and
  clears when it reads again. Spells of no value that the path came back
  from are a [habit](#habits): once it has had three, over six hours, only
  a spell clearly longer than they usually were is reported.
- **A number is a state code only if it behaves like one.** A whole-number
  path with few values starts as discrete, but a value it never had is a
  new state only on its first change, for a path named as a state code, or
  once the path has gone back to a value it had before (a charger 3, 4, 3).
  One that keeps taking new values - a daily figure, a signal strength - is
  measuring, and is not reported at each new value.
- **Kind** is decided from the values. Strings and booleans are *discrete*.
  Numbers are *continuous*, unless the first 20 samples are all integers with
  at most 4 distinct values (a pump state, a mode code), in which case they
  are discrete until a fifth value or a fraction appears. A measurement - by
  its name or its unit (below), including signal strengths (`rssi`, `rsrp`,
  `rsrq`, `sinr`, `snr`, `…SignalStrength`, `…LinkQuality`), `…Jitter`,
  `…Latency`, `rtt`, `…Loss`, and the units dB and dBm - is never discrete,
  however few whole values it has shown: a signal strength sitting at -42
  and -43 dBm for the first minutes is not in state "-42", and -36 is not a
  new state of it. A save that had decided one discrete moves it to
  continuous with its next sample. A number
  that only counts up is a *counter* (engine hours, energy, fuel used), and
  the level and stuck-sensor checks skip it. Never falling is not enough on
  its own:
  - A number listed in `watchCounterPaths` by its exact path is a counter,
    whatever it does. This is how a plugin's own counter under a name the
    watch does not know is declared.
  - Otherwise a measurement is never a counter: a path named as one
    (`…Voltage`, `…Current`, `…Temperature`, `…Level`, `…Volume`,
    `…Pressure`, `…Power`, `…Rate`, `…Stored`, `…Remaining` and the like,
    and anything about satellites), or with a measurement's unit (V, A, W,
    K, Pa, ratio, Hz, m/s, rad, rad/s, m³/s). This holds under a pattern in
    `watchCounterPaths` too: under `plugins.example` its counters are
    counters, and the `batteryVoltage` beside them is still judged. A path
    listed exactly wins over a pattern, wherever it is in the list.
  - A number covered by a pattern in `watchCounterPaths` is then a counter,
    unless its name is a state code's - a whole `state` or `mode`, or a
    name ending in `State`, `Mode`, `Status`, `Type`, `Code`, `Phase`,
    `Fault`, `Error`, `Alarm`, `Name`, `Source`, `Reference`, `Method` or
    `Label`, after a letter or digit (`relay1State`, `inverterACMode`,
    `engineInAlarm`) - which keeps its new-state check. A time or count of a
    state is not a state code: `timeInState`, `secondsSinceLastError`,
    `pulsesInCurrentMode`, `relay1SecondsInState` (a word such as time,
    seconds, ms, hours, duration, elapsed, age, period, dwell, pulses or
    count, starting the name or one of its words, then `In` or `Since`) are
    counters.
  - Any other number is a counter if, over at least 30 samples, it has never
    fallen and is named as one (`runTime`, `…Hours`, `…Count`, `…Total`,

    `energy…`, `lifetimeDischarge`/`Recharge`/`Charge`/`Energy`,
    `…Consumed`, `…Today`, `yield…`, `used`, `odometer`, `log`, `trip`), in
    any unit that is not a measurement's (s, m³, J, C, m, but also h, Ah or
    kWh from a plugin). A drop to (nearly) zero is a reset - a daily yield
    at midnight, a trip log cleared - and does not end it.
  - Any other number that is not a measurement or a state code is a
    counter once it has **only climbed through a whole day of watching**
    (a day has a night in it, and no measurement climbs through one without
    once going down), or once it has **shown itself one by a reset**: it dropped to at
    most 1 % of its value - or, after 100 rises in a row, to any lower
    value (a link that restarts its sequence numbers somewhere else) - and
    then counted up again from there (five rises, none of them recovering
    half the drop), and it has not gone down any other way since. A link's
    sequence number or retransmission count when the link restarts, a
    modem's byte count when it is cleared. A measurement that drops to zero
    stays there or comes straight back, and does not count up from nothing;
    a glitch and back is a fall. While a drop may still be a reset, the
    level check waits for it: a minute (or ten samples) for most paths; up
    to 6 hours, confirmed by two rises, for a path never seen falling that
    has counted 30 times, as a retransmission count restarted from zero may
    not tick again for an hour. A named counter is reset the same way. A
    save from before resets were told from falls learns again, once, whether
    each path falls.
  A climb alone is never enough: a voltage under an unknown name and
  without units can climb for hours without a dip too, and the checks that
  would report it must stay on. A listed counter is
  never treated as a discrete value either, however few values it has had
  (twelve engine starts becoming thirteen is not a new state), and the
  inventory says which entry listed it (`counterBy`). When what the listing
  does to a path changes (not merely the pattern's wording), its kind is
  decided again from new samples. The states it has seen stay known, and
  for the learning period a state seen for the first time is learned
  without a finding; its baseline and the shift, frozen and dropout checks
  carry on unchanged. A path that turns out discrete learns quietly for a
  learning period again from the moment its kind is known (a path that
  changes once in ten minutes needs hours of samples to decide), and its
  switching rate is learned from then too: until it has six hours of
  switching history, it is not reported as cycling. A measurement (by its
  name or units) that was continuous stays continuous rather than being
  decided again, so a reading in whole numbers does not turn discrete.
- **Units, display name and zones** come from the path's own `meta`. The
  watch reads it from update deltas when present and looks it up with
  `getSelfPath`: 50 paths per tick for new ones, and every path again every
  30 minutes. Without metadata, units are inferred from the leaf name
  (`voltage` → V, `temperature` → K, `currentLevel` → ratio, and so on).
- **Inventory**: `GET /watch/inventory` (and **What is watched?** in the panel)
  lists every path found, its role, and which checks this vessel's data
  supports. A role is *watching*, *learning*, *re-learning*, *skipped* (with
  the exclusion pattern) or *read by the GNSS check*. For an unavailable check
  it says what is missing, for example "needs navigation.speedThroughWater".

At most `watchMaxPaths` paths (default 1500) are watched. Paths beyond that are
counted, not watched, and their sources are not compared; an operating-state
path past the cap is still read from its first source only (see
[Operating states](#operating-states)).

## Per-path learning

Each watched path keeps a small, serialisable state object
(`lib/watch/path-monitor.cjs`):

| Learned | How |
| --- | --- |
| Update interval | Moving average of the time between accepted samples. A gap long enough to be a dropout (`max(30 s, 10 × usual interval)`) is an outage. One that follows regular samples is left out of the interval, so one hour of silence does not stretch a 30 s sensor's interval past the regularity limit and hide its next outage, and a sensor that fails again and again has every outage reported. Long gaps one right after another - a sender that reports on change, or goes quiet at night - are its rhythm and count, each up to that limit, so it is not reported at every gap of the night. The interval it was regular at is the one it is judged by afterward: it is updated only while the interval is still a regular path's (a minute at most), so later long gaps do not carry it up, and one short gap after the rise - a second reading a second after a long gap - does not copy the raised interval into it. A path that was regular before such a run stays watched, while the run is unconfirmed and once it is a confirmed slower rate (eight long gaps of about one size, below), but only for a silence of an hour or more, 1.5 times the longest gap it has come back from, or ten times its interval (a day at most), whichever is longest: one that reported every 10 s, then every three hours, and then stopped is reported a day after its last sample (ten intervals would be 30 hours; a silence longer than a day is an outage, never a rhythm). A gap of up to a day that ended while the interval was already raised is the sender's rhythm (its evenings and its nights) and is kept, also across a regular day, so a sender that reports every 10 s by day, every few minutes in the evening and not at all at night is reported on its first night only. A gap that ended while the interval was still regular, or one longer than a day however slow the path was, is an outage: it counts as two hours at most, and only until the path settles regular again, so two days unplugged - also of a slow sensor - do not make a later death wait three days: a sensor whose gaps grew and that then went silent for good is still reported, and one that reports on change, at night up to two hours apart, is not reported at each of its gaps. A save from before the two were kept apart drops the longest gap of a path that has settled regular, whatever its length (it may have been an outage, which the path would have forgotten when it settled); a nightly silence dropped with it is learned again on the next night. A longest gap of more than a day in any save is taken as an outage (two hours, until the path settles). Such a raised path, like one with a learned cycle, does not count toward the data feed's steady paths until its dropout is active, so a gateway that takes down six steady paths and eight raised ones is one silent feed. Eight long gaps in a row, each within half of the run's mean, are taken as the new interval at once. So is a repeating cycle: eight outages of about one size, each after a burst of at most 30 samples - a pair of readings every five minutes - make the cycle's mean gap the interval. A path that has settled (more than 30 regular gaps in a row) needs 24 such outages: until then they are a sensor failing, however regular, and each is reported. Once a cycle is learned, the dropout limit is at least twice its longest outage, whatever the mean gap: a burst sender (ten readings a second apart, then five minutes quiet) is not reported at each quiet spell, and a sensor that fails in a rhythm and then dies is reported (a dismissal lengthens that limit too). A settled regular stretch - more than 30 gaps in a row short enough for a regular path - clears the learned cycle, and so does a plain slower rate (eight long gaps in a row); a slow cycle's own five-minute gaps never do. A restart gives a saved settled path a cycle limit back only if its outages were silences well beyond its interval (more than 1.5 times it), not a sensor that merely slowed down. While it reports, such a path does not count toward the data feed's steady paths; once its dropout is active it counts, regular and silent, so a gateway taking it down with the rest is one silent feed |
| Baseline mean and spread | Exponentially weighted, half-life **30 min**, time-based so "30 minutes" means 30 minutes at any update rate. While a path is learning, the weight is at least `1/n`, so the first minutes are a plain average |
| Fast average | Exponentially weighted, half-life **8 s**, used to compare against the baseline. A one-sample spike barely moves it |
| Sensor resolution | The smallest non-zero step seen three times (within 10 %) among the last 8 steps, where a step that goes straight back the way the one before it came counts once with it. The noise floor is at least twice it, but no more than the coarsest real senders of the unit allow (16 kPa for pressure, ten times the unit's floor otherwise, so 0.05 for a tank: one eighth step stays quiet and full to empty is still reported; 5 % of the value without a unit, but never less than two counts on a whole-number path). A single step, or a glitch out and straight back followed by a real drop of the same size, is not evidence of resolution: a tank that sat at 80 % and dropped to 20 % would otherwise have learned a 60-point resolution and hidden its own drop |
| Transitions | Counted per minute, so a switch cycling every second is counted exactly. "The last hour" is the minute buckets that start inside it — 59 to 60 minutes, never more |
| How long it holds a value | Time spent in runs of one value, by run length in powers of two of a second, per operating state, fading with a 7-day half-life, for the frozen check. A run that a silence interrupted, or that spans an operating-state change, is not learned |
| Habits | The departures it made and came back from on its own, for the level and cycling checks (see [Habits](#habits)) |
| Counting pace | For a counter, the fastest it counted over 10 minutes on each of the last 7 days, for the rate check |
| Discrete states | Count per value (up to 32 values) |
| Series | 60 ten-second buckets (10 min) and 90 one-minute buckets (90 min) |

**Noise floor.** A perfectly steady value has no spread, so the spread used is
never below a floor for what the path measures:

| Unit | Floor |
| --- | --- |
| Temperature (K) | 0.3 |
| Angle (rad) | 0.02 (≈ 1.1°) |
| Speed (m/s) | 0.1 |
| Voltage (V) | 0.05 |
| Current (A) | 0.3 |
| Power (W) | 5 |
| Pressure (Pa) | 30 |
| Ratio | 0.005 |
| Frequency (Hz) | 0.3 (18 rpm) |
| Length (m) | 0.1 |
| Flow (m³/s) | 1e-7 |
| Anything else | 0.5 % of the mean, but at least the path's own resolution while the mean is within it of zero |

**Resolution from decimals.** Before a step has been seen three times, a
path's resolution is the last digit its sender uses, learned from 30 or more
readings within 5 % of its mean: a host monitor that sends disk use as 0.29
and 0.3 reports in steps of 0.01, and moving by one is its rounding, not
news. Such a step is the noise floor once (a learned step counts twice, as a
sensor flickering between two neighbours is not departing). Whole numbers,
values computed in floating point (279.76000000000005) and a departure's own
readings say nothing this way. A reading computed in floating point
(0.29000000000000004) does not erase a resolution learned, and a sender most
of whose readings look like that has none to learn.

A path that sits at zero (packet loss, an alarm count) has no "5 % of its
value", so its floor is its resolution. Before that rule, a mean that had
decayed to 1e-13 after a spike made the floor 1e-9, and the rounding noise
of the decay scored thousands of spreads and kept the finding open.

**Robust updates.** Once a path has settled, a single sample moves the
baseline by at most 4 spreads' worth. While a path is in an *excursion* (fast
average at least `zClear` spreads from the mean), the spread is frozen and the
mean creeps by at most one spread per sample. Otherwise a long departure would
widen the spread until it no longer stood out. An excursion that lasts **60
minutes** is accepted as the new normal and the path re-learns for 10 minutes.

**Angles** are unwrapped before any of this, so a heading crossing north is a
2° change, not 358°.

**Learning period.** A path can raise nothing until it has 30 samples and has
been watched for `watchLearningMinutes` (default 30).

## Checks

`z` below is `(fast average − baseline mean) / max(spread, noise floor)`.

| Check | Fires when | Severity | Persist / clear |
| --- | --- | --- | --- |
| **Unusually high / low** (`shift`) | `\|z\| ≥ zWarn`, and, for a path with a [habit](#habits) of such departures, clearly beyond it; clears below `zClear` | `alert` at `\|z\| ≥ zAlert` (and twice its habit), else `warn` | 15 s / 60 s |
| **Stopped updating** (`dropout`) | A path that updates at least once a minute (30+ samples) has been silent for more than `max(30 s, 10 × usual interval)` | `warn` | immediate / on next update |
| **Data feed silent** (`feed`) | At least 4 regularly updating paths, and at least half of them, are silent at once, having gone quiet together, with nothing on their connections still reporting. Together: each silent path's silence may have begun at one moment - within 5 minutes or its own dropout limit after its last sample for a steady path, within its limit for a cycling or raised one. Of the moments most such paths share, the latest that makes a silent feed is the candidate (else the one most paths share): a group that went quiet an hour before keeps its own dropouts, and its paths are left out of the count, as they were not reporting when the feed went quiet; paths that went quiet after it are counted among the paths the half is taken of. The paths of a silent feed already reported stay in it while they are silent, so a second connection going quiet later joins it rather than unfolding it. Only moments enough paths share to be a silent feed are judged (at least 4 silent, and at least as many as the steady paths still reporting), the 8 newest of them, plus the one most paths share: the work per tick stays bounded however many paths died one by one. A connection is the label the server gives the update's source (`update.source.label`: `can0` for `can0.35`, the plugin's id - `venus` - for every device of a plugin whose `$source` names the device after several dots), kept with the path across a restart; without one (a history replay), the part of the source before its last dot (`can0` of `can0.35`, `n2k.can1` of `n2k.can1.35`); a source with no dot is a connection of its own, and paths with no known source are one. A path is live when it is not overdue (silent for no longer than 1.5 times its interval, and at least the jitter; a raised or cycling one until its own limit) and reported after its connection's paths of the group went quiet (the group, for a connection with none in it) beyond the jitter of its own interval: a sample later than its interval after the last of them, or two samples since. So a connection whose paths stopped a minute before another's is live by what it sent after its own silence: its paths are dropouts, not part of the other connection's silent feed. The jitter is twice the group's shortest interval, 5 s to 1 min. A slow path whose one sample came in a few seconds after the rest went quiet was still on its way, and is not evidence that the connection lives; nor is a raised path seen in that window. A live path, a raised or cycling one included, counts toward the paths the half is taken of; a connection with a live path did not die, so its silent paths are their own dropouts. A raised or cycling path that is neither silent nor live is left out. A connection with a path that is neither live nor overdue yet, and due to report within 2 minutes of the connection's paths going quiet (a steady path an interval after its last sample; a raised or cycling one after its last gap, or a cycle's longest outage, and not yet past 1.5 times that), is undecided: the feed waits for that path, and so do the dropouts of the silent paths that would fold into it - none of them is reported until the path proves live (its connection's silent paths are their dropouts, at once) or misses its next sample (the feed, with no dropouts), and for 2 minutes after that connection's paths went quiet at most, after which it is decided as it stands: a path elsewhere that dies later does not start the wait again. If the silence is a feed even with the undecided connections taken for live, it is reported without them, and their paths wait. So the feed alert comes up to one slow interval, at most 2 minutes, later (with a 55 s path that sent once 12 s after the rest stopped, at 95 s rather than 30 s), and it does not open and then clear into its paths' dropouts a minute later. A finding that opens in the tick an incident resolved joins that incident again, and the incident is then named after it: a silent feed that cleared into its paths' dropouts is no longer *Signal K data stopped arriving*. Reported once instead of per path. Decided over all paths, and reported unless the silence is only the muted paths': at least half of the unmuted regular paths must be silent too, so a gateway that dies is a silent feed even with some of its paths muted, and muted paths going quiet alone are not. A muted path counts only if its silence may have begun at the moment the unmuted ones' did - the test they pass (within 5 minutes or its own dropout limit after its last sample), or with the paths of a feed already reported - and its connection has no live path: a sensor muted because it is unplugged is not evidence that the feed died now, and is left out of the paths the half is taken of; muted paths that went quiet an hour after four unmuted ones did are not one silence with them, and count among the paths the half is taken of, as they were reporting then. At least 4 unmuted paths (or all of them, if fewer) must be silent. The dropouts of the paths it counts fold into it; other dropouts stay open. Muting `feed` mutes it; the counted paths' dropouts stay folded into it while muted | `alert` | immediate |
| **Looks stuck** (`frozen`) | A continuous path repeats exactly the same non-zero value 30+ times, for at least 5 minutes and at least twice as long as it normally holds one value in its current operating state (100+ samples, and 30+ runs over 30+ minutes of them, learned). "Normally" is the run length below which 99 % of its time was spent, rounded up to a power of two of a second: a wind sensor that never holds a value for more than 2 s is stuck after 5 minutes of one; a stopped engine's coolant that sits on one reading for half an hour is stuck after a little over two hours; a counter that ticks in bursts and then sits for hours is a counter (or holds for hours) and is not stuck. Not while it re-learns, and not while it is silent or sends no value (its dropout reports that): the hold is timed to its last sample. Only against enough of the path's holding: the runs learned must add up to six times the limit, and a limit longer than 5 minutes is judged only once they cover a day of watching - observed time, so hours the plugin was down and spells of no value do not count (slow sensors sit still longest at night; a sea-water temperature's evening plateaus say nothing of its night). Reading again after a spell of no value starts a new hold. A silence, an operating-state change or a restart starts the hold again from then, so a sensor that comes back stuck is judged from its return | `warn` | immediate |
| **New state** (`newState`) | A discrete path takes a value never seen before, after learning. Held 10 minutes | `warn` | immediate |
| **Cycling** (`cycling`) | After 6 h of observation, transitions in the last hour ≥ `max(4, 3 × usual hourly rate + 2)`, and, for a path with a [habit](#habits) of such spells (a solar charger flapping at every dusk), clearly beyond it | `alert` at twice that (and twice its habit), else `warn` | immediate / 10 min |
| **Counting unusually fast** (`rate`) | A counter, after a day of its pace, counts at least 4 times faster over the last 10 minutes than the fastest it counted in any 10 minutes over the past 7 days, and by at least 10 steps of its resolution. Rates go into the record only after two windows without a surge, so the build-up of one does not raise the bar it is judged by. A surge that lasts an hour is the counter's pace now and is learned. A counter that has not counted at all all week (a record of zero, as opposed to no record yet) surges at 10 steps of its resolution in 10 minutes (one step for a whole-number count without a learned resolution), and clears below half that. Clears below twice the record | `alert` at 10 times, else `warn` | 2 min / 5 min |
| **Heading for a limit** (`forecast`) | A linear trend (R² ≥ 0.6) reaches a limit within its horizon (see below) | `warn` | 2 min / 5 min |
| **Sources disagree** (`disagree`) | See [Redundant sources](#redundant-sources) | `alert` at `zAlert` | 30 s / 60 s |
| **Switched source** (`failover`) | See [Redundant sources](#redundant-sources). Held 10 minutes | `warn` | immediate |
| **GNSS** (`gnss.*`) | See [GNSS integrity](#gnss-integrity) | `alert` when two indicators are active at once | per indicator |
| **Your watch** (`rule`) | See [Your own watches](#your-own-watches-rules) | as written | your duration (min 5 s) / 30 s |

**Sensitivity** (`watchSensitivity`):

| | `zWarn` | `zAlert` | `zClear` |
| --- | --- | --- | --- |
| `low` | 8 | 14 | 4 |
| `normal` | 6 | 10 | 3 |
| `high` | 4.5 | 8 | 2.5 |

A ramp is caught by the same check as a step. The fast average follows the
ramp while the slow baseline lags it, by about the ramp rate × 43 minutes. When
the value is still moving, the message adds the rate over the last 90 seconds,
but only when that rate is itself beyond the noise.

**Forecast limits:**

| Path | Limit | Horizon | Trend window |
| --- | --- | --- | --- |
| `tanks.{fuel,freshWater,lubrication,gas}.*.currentLevel` | 10 % | 3 h | 60 min, 10+ points |
| `tanks.{wasteWater,blackWater}.*.currentLevel` | 90 % | 3 h | 60 min, 10+ points |
| `electrical.batteries.*.stateOfCharge` (or `.capacity.stateOfCharge`) | 20 % | 2 h | 60 min, 10+ points |
| Any path with `meta.zones` in `warn`, `alert`, `alarm` or `emergency` | the zone boundary | 30 min | 15 min, 5+ points |

A value already past its limit is not forecast: that is the zone's own alarm.

### Skipped by default

These paths change with the helm, the wind and the seabed, so a sudden change
in them is seamanship, not news (`watchDefaultExclusions`):

```
navigation.position  navigation.gnss  navigation.datetime
navigation.courseOverGround*  navigation.heading*  navigation.attitude
navigation.rateOfTurn  navigation.speedOverGround  navigation.speedThroughWater*
navigation.leewayAngle  navigation.course  navigation.courseRhumbline
navigation.courseGreatCircle  navigation.destination  navigation.anchor
navigation.trip  navigation.log  navigation.magneticVariation*
environment.wind  environment.current  environment.depth  environment.tide
environment.sun  environment.moon  environment.mode  environment.time
steering  performance  design  resources  communication  **.runTime
```

Pattern rules: a path covers everything beneath it, `*` matches within one
segment, `**` across segments. `notifications.*` is never watched.

Skipped paths are still recorded for rules, still compared across redundant
sources, and the GNSS check still reads position, heading, speed through water,
satellites, dilution and time.

## GNSS integrity

`lib/watch/gnss.cjs`. Jamming and spoofing do not trip limits: a jammed fix
degrades or freezes, and a spoofed one looks healthy somewhere else. Each
indicator uses evidence the receiver does not control:

| Indicator | Fires when | Persist / clear |
| --- | --- | --- |
| `jump` | Two consecutive fixes from one source are more than 100 m apart **and** imply more than 40 kn. It waits for the source's next fix: back where the vessel was before (nearer to it than to the jumped fix, and within 100 m of it or no faster than 40 kn from there), the fix between was one bad fix and not a jump - an AIS transponder sending its own position, as it starts, rounded to 60.28, 22.285 between precise ones. Anywhere else, or no next fix within 5 s (three of that source's own intervals, if longer), it is reported, and held from then; when it was first seen is in its evidence (`detectedAt`). Each source's jump waits for its own next fix. `alert` above 5 km. Held 10 min | immediate |
| `deadReckoning` | The fix is further from dead reckoning (true heading + speed through water, integrated from an agreeing fix) than **150 m + 25 % of distance run + 2 kn × elapsed time**. Heading and log must be fresh (≤ 5 s). The reference is re-anchored every 10 minutes, and only on a fix that agrees, so a spoofed position never becomes the reference | 30 s / 60 s |
| `sourcesDisagree` | Two position sources updated within 10 s of each other are more than 100 m apart | 30 s / 60 s |
| `quality` | Fewer than 4 satellites, or horizontal dilution above 5, on a receiver that has reported at least 6 satellites or dilution below 2 at least 20 times | 30 s / 60 s |
| `frozen` | Consecutive fixes (no more than `max(5 s, 3 × the usual fix interval)` apart, so a receiver reporting every 10 s keeps the check) have not moved (< 0.5 m) for 60 s while speed through water is above 1 m/s. A fix that moved, a gap in the feed, or a log that is stale or reads under 1 m/s ends the candidate, and the check also needs a fix and a log reading from the last few seconds, so a boat that slowed and stopped, or a feed that paused, is not reported | immediate / 10 s |
| `lost` | After 30 fixes, none for `max(30 s, 5 × usual fix interval)`. A gap that long is an outage and is left out of the usual interval, so a receiver that drops out twice is reported both times; only a run of eight long gaps of about one size (each within half of the run's mean) is taken as the receiver's new, slower rate. Until then a receiver that really slowed down is reported lost after each of those first fixes whose gap is over the loss threshold (a slower rate below it, 20 s after 1 s, is learned without a loss report), and a receiver whose fixes keep coming only every 20 to 40 s for eight fixes in a row is taken as reporting at that rate, so its loss is reported after five of those intervals. Position is excluded from the per-path dropout check, so this is what notices a receiver that stops. The GNSS status then reads `lost`, as it does for any fix older than a minute | immediate |
| `clock` | `navigation.datetime` jumps more than 30 s against the server clock, after 10 samples. Held 10 min | immediate |

Two indicators at once escalate every GNSS finding to `alert`. All GNSS
findings share one notification, `notifications.watchkeeper.gnss`, and one
incident that never merges with other systems.

## Redundant sources

`lib/watch/sources.cjs`. When several sources publish one path, the first one
seen is primary and only its samples feed the baseline. Mixing them would make
a calibration offset look like noise, or a step at every switch.

- **Disagree**: each other source is compared with a fresh primary sample
  (within `max(5 s, 2 × interval)`). The usual offset is learned **per
  primary/secondary pair**, with its sign (B minus A), so a constant offset
  is normal and one sensor's offset cannot hide another's fault. It fires
  when a pair's difference departs from its usual offset by `zWarn` spreads
  and by at least 3 noise floors, after 30 comparisons: B moving from a volt
  above A to a volt below it is a two-volt departure, though the gap is a
  volt either way. Pairs in a baseline saved before the offset was signed
  (which held the mean of the gap's size) learn it again. Pairs learned under an earlier primary are kept but not judged.
  Up to 16 pairs per path; when full, the least recently compared pair of a
  former primary makes room, so the current primary's pairs are always
  learned.
- **Failover**: when the primary has been silent for `max(10 s, 5 × interval)`,
  the next source becomes primary. If the old primary was established (30+
  samples), that is reported, because the path kept updating and a dropout
  check would never see it.

This runs on skipped paths too: two compasses disagreeing is news even though
heading itself is expected to swing. Up to 8 sources per path, and up to 500
skipped paths with more than one source. The source a skipped path was heard
from first stays its primary when a second source appears, with its sample
count and its interval: a failover from a source that had sent alone for an
hour is reported, and one that reports every 30 s is not replaced 10 s after
its last sample. A skipped path's interval is its primary's, learned as a
watched path's is: a gap as long as a dropout after regular samples is an
outage, not its interval (gaps that long one after another, a source that
slowed down, count up to that limit). Each source's interval is learned
from its own samples, and a new primary is judged by its own (from its next
sample if it has none yet), so the silence that made a 1 s source fail over
does not make the next failover wait half an hour, and a 20 s source that
took over from one that slowed to 45 s is not handed back at the slow one's
next sample. Paths past `watchMaxPaths` are not compared.

## Operating states

Some changes are expected together. When an engine starts, its temperatures
climb, the alternator lifts the battery voltage and fuel flow appears. These
*gates* recognise operating-state changes. A gate reads its path's primary
source only, so a second source reporting another value (a second engine
interface saying 0 rpm) does not flip the state back and forth:

| Gate path | States | Affects | Settle |
| --- | --- | --- | --- |
| `propulsion.<id>.revolutions` | `running` above 0.5 Hz (30 rpm), else `stopped` | `propulsion.<id>.`, `electrical.`, `tanks.fuel.` | 15 min |
| `propulsion.<id>.state` | its value | same | 15 min |
| `electrical.{charger(s),inverter(s),solar,alternator(s),ac}.<id>.{chargingMode,mode,state}` | its value | `electrical.` | 10 min |
| `navigation.state` | its value | `propulsion.`, `electrical.`, `tanks.` | 10 min |
| The sun at the vessel (`watchkeeper.daylight`), worked out from `navigation.position` and the time | `day` with the sun 3° or more above the horizon, `night` 7° or more below it, `twilight` between (with 0.5° of hysteresis at each boundary) | `electrical.solar.`, and whatever else it is learned to move | through twilight, and 15 min after it |
| Any other path that changes state (a discrete path's value) | its value | the paths it is learned to move (below) | half again as long as their answers last, 2 to 15 min |

**Operating states are also learned from the data** (`lib/watch/drivers.cjs`).
The named gates are what most boats have, not all a boat has: a watermaker,
a generator, a fridge compressor, an inverter a plugin names its own way.
Every time a departure begins on a path, the watch notes which paths changed
state in the 5 minutes before - any discrete path's value, any gate's
regime, the sun. If a path's departures follow one of them far more often
than a 5-minute window would contain a change of it by chance (a binomial
tail below 1 in 1,000, from how often that path changes at all), the pair
is learned. From then on that change is an operating-state change for that
path, exactly as a named gate's: it re-learns through it and has back the
baseline it had in that state. A path that changes all the time (a
timestamp) is in every window and explains nothing; a watermaker that starts
every two hours explains the current that rises each time, after a few runs.
Learned pairs are listed in the inventory (`learnedStates`) and kept across
restarts; the named gates' own entries stay as priors, and what is learned
adds to them.

The sun's elevation comes from the low-precision solar position of the
Astronomical Almanac (`lib/watch/sun.cjs`), once a minute from a position
fix, so no sun path or other plugin is needed. Fixes come from one receiver,
as every gate reads one source: another takes over only after the one
followed has been silent for 5 minutes, so a faulty second GPS cannot flip
day and night. Twilight is a state of its
own because that is where solar paths change: a panel's voltage comes up in
the dawn long before the sun does, and goes in the dusk after it has set.
Solar paths re-learn for as long as the twilight lasts (an hour in a
northern winter, all night near midsummer), and are judged again once the
sun is clearly up or down. Only the night's baseline is restored (panels at
0 V are the same every night); a day's depends on the weather and the season
and is learned afresh each morning.

**A flapping gate waits.** A gate that has changed more than 4 times in the
last hour (a solar charger hunting between `bulk` and `off` in poor light,
several times a minute) is held: its changes are applied only once it has
kept one state for 10 minutes. Without that, every change would start the
paths it affects re-learning, and they would be watched by nothing all day.
A gate that changes rarely, like an engine starting, still acts at once.

On a change, every affected path:

1. **files its settled baseline** under the state it is leaving, if it had been
   settled for at least 10 minutes and is not in the middle of a departure
   (its mean is held back then, and is not its level in that state). Up to 6
   states per path are kept.
2. **re-learns** through the settling period, raising nothing.
3. **restores** the baseline it learned the last time it was in the new state,
   once the settling period ends, if there is one and the new state is active.
   Every path also keeps how long it holds a value per operating state, so a
   stopped engine's quiet temperatures do not excuse a freeze while it runs.
   Resting states (`stopped`, `off`, `idle`, `standby`, `disabled`, `moored`,
   `0`) always re-learn, because a cooling engine is not at a steady state.

Step 3 is what makes the second engine start useful. It is judged against how
this engine normally runs, so an engine that settles 10 °C hotter than usual
is reported instead of being quietly re-learned as the new normal.

## Habits

A path's baseline says what it normally reads. Its habits say what its
unusual moments normally look like: a radio link whose packet loss spikes
for a minute several times a day, a solar charger that flaps between modes
at every dusk. Reporting each of those teaches the crew to ignore the watch.

An *episode* is a stretch where a check's score stays at or above its clear
level (`zClear` spreads for the level check, its threshold for cycling),
kept apart for rises and drops. When it ends without being re-learned or
accepted as the new normal, its peak and length are kept (40 at most, for
14 days, enough to span six hours however often they come); one that starts
again before as long as the last one lasted has passed (a minute at least)
is the same one back again. A departure that is accepted as the new normal
is kept too, as a habit of level changes (`level`): a daily figure that
steps at midnight, a setpoint moved. Once a path has had at least **3**
episodes, over at least **6 hours** - the least a habit's size and spread
can be read from - a new one is reported only if it goes further, or lasts
longer, than the path's own episodes make likely:

- How far is fitted to the path: its peaks and lengths as log-normal, with
  the spread shrunk toward a prior while there are few. A link whose spikes
  are all alike is news a little beyond them; one whose spikes vary widely,
  only well beyond.
- How likely is the **alert budget**, the one number the sensitivity sets:
  how many of a path's routine episodes a day may still be reported - about
  one a month at normal (0.03 a day; 0.01 at low, 0.1 at high). A path that
  has ten episodes a day gives each one chance in 300 at normal.
- Never past the path's own record by more than its own scatter (as far as
  the sensitivity reaches): a departure further than any the path has made
  and come back from is news, however widely its episodes vary.

The first ones are always reported, and so is a departure of a new size.
The finding then says what the path usually does ("it has had 7 such rises
in the past 3 days, usually up to 8.1×, lasting up to 2 min"), the watch
report lists what it has learned to expect, and `status()` has them under
`habits`. Marking a finding on the path **useful** (or resetting its
feedback) forgets them: a departure the crew wants to hear about is never
got used to.

## Findings, incidents and notifications

A check's condition passes through a tracker that applies its persistence
(how long it must hold before it is a finding) and hysteresis (how long it must
be gone before the finding clears). An open finding can rise in severity but
does not drop back.

**Incidents** group findings. A new finding joins an active incident if it is
in the same system (the first two path segments, for example
`propulsion.main`), or if it starts within 3 minutes of the incident's last new
finding. GNSS findings only ever group with GNSS findings. Findings are listed
in the order they started, so the first one is labelled *first sign*. An
incident is named after its first finding, or, once it resolved and a
finding that opened in the same tick reopened it, after that finding. An
incident keeps at most 50 findings: past that its oldest cleared ones are
dropped, its title (*… (+N related)*) still counts them, and the incident
carries their number as `omitted`, which the panel and the copied incident text
show as *N earlier findings not shown*. The last 50
incidents are kept.

**Notifications.** Each watched path gets one notification carrying its worst
open finding, plus one each for GNSS, the data feed and each rule:

```
notifications.watchkeeper.<path>
notifications.watchkeeper.gnss
notifications.watchkeeper.dataFeed
notifications.watchkeeper.rules.<rule id>
```

```json
{ "state": "alert", "method": ["visual"], "message": "Main engine temperature unusually high: 92.9 °C, +12.2 °C from its usual 80.1 °C (40.6× its normal variation)" }
```

- States are `warn` or `alert`, never `alarm` or `emergency`, which belong to
  real alarm sources.
- `sound` is added for `alert` when `watchSound` is on.
- A state change is published at once. A message whose numbers merely
  refreshed is republished at most once a minute.
- What was sent is recorded only once the server accepts the batch. A
  refused batch is retried on the next tick, so a warning or its clearance is
  never lost.
- A cleared finding publishes `normal` with "Back to normal: …".
- Stopping the plugin clears every watch notification.

**Mutes** (`POST /watch/mute`, or **Mute 1 h** in the panel) suppress a path or
pattern for 1 minute to 7 days. Muting `navigation.position` mutes the GNSS
checks, and muting `feed` mutes the data-feed finding.

## Your own watches (rules)

A rule is stored data, checked deterministically on every tick:

```json
{
  "id": "r-mf3k2a-7x1q",
  "text": "Alert if the coolant goes above 90 for 30 seconds while rpm is above 600",
  "path": "propulsion.main.temperature",
  "op": "above",
  "value": 363.15,
  "forSeconds": 30,
  "when": { "path": "propulsion.main.revolutions", "op": "above", "value": 10 },
  "severity": "alert",
  "createdAt": 1794685523434,
  "source": "parser"
}
```

- A negated comparison is its opposite, inclusive: "not above 95" is
  `atMost` 95, "not below 12" `atLeast` 12, "does not exceed" `atMost`, in a
  rule and in its guard. "No higher than 14" is `atMost` 14 and "no lower
  than 12" `atLeast` 12; "no hotter, warmer or faster than" are `atMost`,
  "no colder, cooler or slower than" `atLeast`.
- A rule says when to alert. A limit is not negated: "should not exceed 14
  V", "must not go above 95", "can't drop below 12" and the other modal
  forms (should, must, may, shall, can, could, will, would, and their
  contractions) read like "never above": the watch fires when the limit is
  crossed, `above` 14, `below` 12.
- A requirement without "not" - should, must, shall, needs to, has to or
  ought to, then the comparison or be, stay, remain, keep, be kept or read -
  says what is normal, and the watch fires on its opposite: "should be below
  14 V" is `atLeast` 14, "must stay above 12 V" `atMost` 12, "should be no
  higher than 14 V" `above` 14 (the same as "should not exceed 14 V"). The
  read-back quotes those words as written ("must stays above 12 V") and
  says they were read as what is normal, and the rule it
  shows ("Warn when ... is at least 14.0 V") is the alert.
- A request that says when to alert - "if", "when", "whenever", "in case"
  or "once" anywhere before the comparison, whatever the punctuation ("tell
  me if", "alert me, if", "send me an alert if", "if ..., tell me") - and
  also has a modal about the comparison (should, must, shall, needs to, has
  to, ought to, may, might, can, could, will or would, with or without
  "not") is refused: "alert me if the battery voltage should be below 12 V"
  may mean below 12 V or what is normal, so the refusal offers one plain
  phrasing for each reading: 'Say "alert me if the battery voltage is below
  12 V" or "alert me if the battery voltage is at least 12 V".' A "tell
  me", "alert me", "notify me" or "let me know" after the comparison with
  none of those words before it only says how to be told: "depth should be
  at least 3 m, warn me" is `below` 3 m, as without it. A condition said
  before the subject ("when the engine is running battery voltage should
  stay above 12 V") is refused with the "while" to say instead ("battery
  voltage at most 12 V while the engine is running"). A word that ends a
  name on the vessel ("the jerry can") is no modal there, and a condition
  word in one ("the once battery", "When tank") is no condition. A "while"
  right before a clause makes it the "while" wherever it stands: "alert
  while the engine is running if the coolant is above 95 °C" watches the
  coolant.
- Refused as ambiguous too, with the same two phrasings: may, might, can,
  could, will or would as a modal without "not" - with a verb after it, or
  before "exceed" ("may be above 14 V" says neither when to alert nor what
  is normal; "the jerry can is below 20 %" has no modal, and a name on the
  vessel that ends in such a word is that name); and a requirement with a
  verb of crossing ("should drop below 12 V", "should exceed 12 V" may be
  the alert or what is normal). In a "while", which says when the watch
  applies, these and a requirement are refused with the condition said
  plainly instead, in the request's own words ("while battery voltage is
  below 12 V", "while the engine revolutions are above 600 rpm"): a
  "while" is no alert. So is a limit said with a modal or "never" there
  ("while the engine revolutions should not exceed 600 rpm" may mean while
  they are within it or past it), with both conditions offered. These, like
  a comparison negated twice, are never passed to the
  model: it would have to guess too, so the reason is shown instead. The
  refusal quotes the condition as written, without the "warn me" after it.
- A comparison negated twice ("is not not above 95", "is not no higher than
  14", "never goes no higher than 14") is refused rather than read either
  way.
- `op` is one of `above`, `below`, `atLeast`, `atMost` (numbers; `atLeast`
  and `atMost` are the inclusive `>=` and `<=`, so "at least 12 V" holds at
  exactly 12 V), `equals`, `notEquals` or `changes`.
- `value` is in SI, like the data. `equals` treats `true`, `1`, `"on"`,
  `"true"`, `"running"` and `"started"` alike, and `false`, `0`, `"off"`,
  `"false"` and `"stopped"` alike, in any letter case: the same words the
  parser reads as on and off.
- `changes` fires for 10 minutes after the change is seen, once per change;
  a rule with a duration keeps the change for that duration plus 1 minute
  when that is longer, so a `changes` rule with `forSeconds` of 600 or more
  can still fire. Changes are counted as the data arrives, so a value that
  goes on and back off between two ticks is still a change. On a `changes`
  rule the duration is a delay: a change is reported that long after it was
  seen, even if the value has gone back since. A change made while the path
  is muted is not reported when the mute ends.
  While the `when` condition is known to be false, the rule keeps up with the
  value silently. While the `when` data is stale, nothing is judged and the
  10 minutes of a change not yet reported stop running: it is reported once
  the guard is heard from again, however long that takes, and a change
  already reported is not reported a second time when the guard returns. Until the guard has been heard at all
  since start, the rule has no starting value, so it begins from the value
  present when the guard is first heard.
- The rule and its `when` guard need data no older than 5 minutes. Without
  it the rule cannot be judged and does not fire.
- A rule that is removed takes its pending duration with it: added again
  later, it starts counting afresh instead of firing at once. So does a rule
  whose path, operator, value or guard is edited: the new condition has to
  hold for the full duration itself, and a finding it had open closes.
- A "changes" rule whose value goes stale closes its finding, and a change it
  already reported is not reported again when the value is heard from, nor
  when the rule's value or guard is edited.
- At most 50 rules. They are stored in the plugin's options as `watchRules`.
  A rule added or saved through the routes is checked like a compiled one (a
  word or on/off on a measurement is refused); a rule already stored as it
  is is not judged again, so a list saved before the check, or a rule on a
  flag that is quiet just now, can still be saved. A rule without a valid id
  gets one derived from what it says, the same each time it is read.
- A word is a value only on a path that has states: "becomes warm" on a
  temperature, or "changes to empty" on a tank level, is refused with a request
  for a number, rather than stored as a watch that can never fire. "Switches on
  and off", "switches on/off", "starts and stops", "changes state" mean any
  change. A quoted state is one value, as written: its punctuation and any
  *while*, *and* or urgency word inside it are part of the state
  (`changes to "fault, low"`).
- One `while` condition per rule, and one comparison in each. A request with
  two `while` conditions, three comparisons, or two joined by *or* or *but*,
  is refused rather than stored with one of them silently dropped, and it is
  not passed to a model, which could only drop one too. Two things joined by
  *and* ("coolant above 95 °C and the shore power is on") are refused with
  the hint to say *while* instead, which is what a rule holds; that one may
  go to a model, whose reading the operator checks. A joined comparison the
  parser refuses on its own ("coolant above 95 °C and battery voltage may be
  below 12 V") refuses the request with that comparison's own reason, and it
  is not passed to a model either.
- Every write to the plugin's options (rules, path selections) goes through
  one queue, so two overlapping saves cannot undo each other. The panel adds
  and removes one rule at a time (`/watch/rules/add`, `/watch/rules/remove`),
  applied to the rules as stored, never to its own possibly stale copy. A
  rule sent without `createdAt` is stamped once per change, so a change
  redone after a restart finds the list its first attempt stored, and writes
  nothing more.

**Reading plain language** (`lib/watch/rule-parser.cjs`), with no model:

- Comparisons: *above, over, higher/more/greater than, exceeds, hotter/warmer/
  faster than, below, under, lower/less than, colder/cooler/slower than*,
  `>`, `<`; inclusive *at least, at most, no less/more than*, `>=`, `<=`;
  *is on/off*, *switches on*, *runs*, *starts*, *stops*, *is not …*,
  *changes to …*, *becomes …*; and, with no target state, *changes*,
  *switches*, *toggles*.
- Units: °C, °F, K, V, A, W, kW, %, kn, m/s, rpm, Hz, hPa, mb, mbar, kPa,
  bar, psi, Pa, m, ft, nm, L, L/h (spelled out too: *degrees celsius*,
  *°celsius*, *volts*, *knots*; `º` for `°`). A number without a unit is read
  in the unit the panel shows for that path ("above 95" on a coolant
  temperature is 95 °C). A unit it does not know ("below 30 cm") is refused,
  not read as no unit, and so are words left over after the comparison
  ("above 95 °C during the storm"). Words that start with *on, in, at, of,
  for* or *from* may narrow the subject ("below 12 V on the house bank"):
  the subject picks the paths, and these words choose only among the ones
  that fit the subject's words as well as the best does (as many of each
  word's meanings, or at least two: "coolant" is a propulsion temperature,
  the engine-room air is only a temperature), so "coolant above 95 °C in
  the engine room" never watches the engine-room air. A request with no
  subject before the comparison ("tell me if it gets above 40 °C in the
  engine room") takes these words as its subject. They are kept only if the
  path picked answers to every one of them (apart from *bank, side, unit,
  system, circuit, sensor, one*) and add something to the subject, or repeat it
  with *on, of, for* or *from* and one of those words ("the house battery
  ... on the house bank"):
  "above 95 °C at anchor", "on the port side" of a boat with one engine,
  "below 12 V at night" or "the anchor light is off at anchor" is refused,
  not stored as a watch that ignores them, and a qualifier that names none
  of the subject's paths offers none to pick, so picking one cannot drop
  it either. A subject word that no path answers to (other than those
  words, or *boat* and *vessel*) is named in the refusal, not narrowed
  away; only a word that says which without naming a thing (*main, new,
  second, spare, backup*...) is left to the qualifier when the subject is
  clear without it ("main battery ... on the house bank"). *Switch,
  breaker, relay, fuse, contactor* are answered by any path with states.
  A room within the boat that is not lived in (`environment.inside.engineRoom`,
  the fridge) is not its *cabin* or *saloon*; a cabin, saloon, galley or
  cockpit is, unless its name also names such a thing ("Galley fridge"). A state ("is on", "is fault") is first looked for among paths with
  states (not measurements by name or units, or a `.state`/`.mode`/
  `.status` leaf, whatever its units, or data seen as a flag or word; on a
  flag, only on/off words are values), so "the shore power is
  on" is the shore-power switch beside an `electrical.ac.shore.power`
  reading. Such a path is taken only if it answers every word of the
  subject and is the thing itself, not a separate device named after it
  (the engine's blower is no answer to "the engine is running", nor the
  fridge's fan to "the fridge is on", nor `engineStartRelay` or
  `engineBlower1`). What a path is, is said by the words after the thing's
  own word: `batteryCharger` is "the charger". Beyond the thing itself, at
  most one word may follow, a part or a place of it (*pump, compressor,
  motor, masthead, forward, aft, port, starboard...*), and a number says
  which one: `bilgePump` for "the bilge", `anchorLightMasthead` and
  `bilgePump1` are still the thing. When the plain reading is such a device, a single path
  with states that is the thing itself is taken ("the main engine is
  running" is `propulsion.main.state`, not the main engine's blower), and
  otherwise those are offered first; a measurement
  the request names ("the shore power voltage is off") is refused, with
  the reason, and when neither fits every word the choice is asked among
  the paths with states. An instance number is a word ("battery 2",
  "engine 2"). Without a number in the request, a numbered instance counts
  as unexplained beside a named one ("battery" on a boat with
  `batteries.0` and `batteries.house` asks which) unless its display name
  answers a word its path does not; a display name only scores for such
  words, so "House battery" on `batteries.0` makes it no better a battery
  than its neighbour. With a number, a path's number does not settle a tie
  its display name contradicts. Two words that a path writes as one
  ("engine room", `engineRoom`) match it, and an engine room is not an
  engine. A single quote is a quote only at a word's edge, so
  "isn't" and "the pump's" are words, and empty or blank quotes are refused
  as no value. Urgency words, *now, again, then,
  send a notification* and the like are fine after the comparison.
- Duration: *for 30 s / 2 minutes / 1 hour*, optionally *or more*,
  *straight*, *in a row*, *continuously*.
- Urgency: *alarm, alert, urgent, critical, emergency, immediately* →
  `alert`.
- Conditions: *while, whilst, only when, only if, but only if/when/while, as
  long as, when, if*.
- Paths: chosen from what this vessel publishes. The request's words are
  matched against path segments and display names, with everyday synonyms
  (*coolant, fridge, house battery, barometer, rpm, cabin, sea, shore, bilge*).
  A typed unit rules out paths that cannot carry it, and path segments the
  request does not account for count against a path. When two paths fit
  equally well, the parser returns both for the operator to choose instead of
  guessing.

**Reading what the parser cannot** (`lib/watch/rule-assist.cjs`), only if
the AI help is switched on and `ruleAssistModel` names a model (see
[Settings](#rules-in-your-own-words--optional-ai-help-ruleassist)):

- The model gets the request and at most 25 candidate paths (the parser's
  alternatives first), each with its display unit. It is told the parser's
  readings: what is normal alerts on its opposite, a limit with "not" on
  crossing it, and a modal about the comparison in a request that also says
  when to alert says neither side. A request the parser refused as
  ambiguous is not passed on.
- The answer is held to a JSON schema (Ollama's `format`) whose `path` and `op`
  fields allow only those paths and operators.
- Settings: `temperature 0`, `num_predict 160`, `num_ctx 2048`, thinking off,
  60 s timeout. The body of an error reply is read for at most 2 s, so a
  backend that sends a status and then stalls does not hold the request.
- Every number in the answer, for any operator, is in the unit shown for the
  path and converted to SI ("equals 90" on a coolant temperature is 90 °C).
  An answer that is not a JSON object is reported as no rule.
- The model is `ruleAssistModel` on the Ollama server at `ollamaUrl`, and it
  is let go 2 minutes after use (`keep_alive`), so it does not hold GPU memory
  another model on that host needs.
- Ollama only.

Either way the result is validated, read back in plain words, and shown with
its current value and how often it held over the watch's last 90 minutes. A
rule read by a model is labelled as such. Nothing is stored until the operator
adds it.

## Feedback and the watch report

**Feedback.** The operator teaches the watch which findings are worth an
interruption:

- **Not useful** on a finding (`POST /watch/feedback { path, useful: false }`),
  or muting an exact path while it has an open finding, is one dismissal.
- Dismissals decay with a **14-day half-life**. A path with at least half a
  dismissal left gets a threshold factor of `1 + 0.25 × dismissals`, capped at
  **2**.
- The factor multiplies `zWarn` and `zAlert` for the level (`shift`) and
  source-disagreement checks (on watched and skipped paths alike), and the
  silence a `dropout` needs. Other checks — stuck sensors, new states,
  cycling, forecasts, GNSS, your own watches — are unaffected, so a dismissed
  stuck-sensor finding can recur just as before; mute the path for that.
- **Useful** (`useful: true`), or resetting a path's feedback, also forgets
  the path's [habits](#habits): what the crew wants to hear about is never
  got used to. Dismissals are not needed for a departure that keeps coming
  back on its own - the watch learns to expect it by itself.
- An open finding is not closed by feedback: it clears through its normal
  hysteresis. The next departure has to be bigger.
- `useful: true` removes one dismissal, and `"reset"` forgets them all
  (**Restore** in the panel).
- `GET /watch/status` lists every affected path under `lessSensitive`, and the
  inventory shows the factor per path, so nothing is tuned out of sight.
- Feedback is saved with the rest of the state.

**Watch report** (`GET /watch/report?hours=24`, 1–168 hours). It is built from
the open findings and a log of the last 1,000 closed ones, kept for 7 days and
saved across restarts. It returns counts (`incidents`, `alerts`, `findings`,
`byDetector`) and plain `lines`:

```
2 incidents (1 alert, 1 warning) from 5 findings.
Still active: Engine room temperature stopped updating.
Longest: House battery voltage unusually low, 42 min.
Repeated: House battery voltage unusually low ×2.
Sensors and data: Engine room temperature stopped updating.
GNSS: no warnings; dead reckoning or a second receiver cross-checked the fix (last at 11:58 UTC).
Your watches fired: Main engine temperature is above 90.0 °C for 30 s.
Operating changes: Engine main running at 08:12 UTC, Engine main stopped at 11:40 UTC.
Less sensitive after your dismissals: Water temperature.
```

Times are in UTC, so the report means the same thing whatever the server's
time zone. The GNSS line says the fix was cross-checked only if dead reckoning
or a second receiver compared against it inside the report's window. **Copy
for the log** puts these lines on the clipboard.

## Where the language model is and is not used

| Part | Model |
| --- | --- |
| All checks, all thresholds, all firing decisions | none |
| Finding, incident and notification text | none (templates) |
| Stored rules at watch time | none |
| Reading a typed rule | none, unless the parser fails and the AI help is switched on with a model named |
| Incident, "most unusual" and report text | none (the panel copies it as plain text) |
| Learning from dismissals | none (a per-path threshold factor) |

## HTTP API

All routes are under `/plugins/signalk-watchkeeper`. While the plugin is stopped
they answer `503`; a rule add, remove or save the plugin stops right after
storing answers `503` saying the change was saved, so it is not made again -
also when a restart loaded the change and the redone save found nothing left
to write.
Routes marked *write* need a login with `readwrite` or
`admin` access when Signal K security is on, and answer `401` otherwise.

| Route | | Returns |
| --- | --- | --- |
| `GET /watch/status` | | `enabled`, `running`, `usesLanguageModel: false`, `subscription`, `restoredBaseline`, `startedAt`, `samples`, `sensitivity`, `paths` (watched/ready/learning/relearning/excluded/capped), `sourcesCompared`, `activeFindings`, `incidents`, `regimeChanges`, `gnss` (status and indicators), `rules`, `mutes`, `lastError?`, `lastReplay?` |
| `GET /watch/inventory` | | `totals`, `branches`, `capabilities[]` (`id`, `label`, `available`, `detail`), `paths[]` (`path`, `role`, `kind`, `units`, `intervalMs`, `sources`, `excludedBy`) |
| `GET /watch/unusual` | | `rows[]`: `path`, `score`, `title`, `message`, most unusual first |
| `GET /watch/series?path=…` | | `minutes` and `recent`, `[timeMs, SI value]` pairs. `404` for an unknown path |
| `POST /watch/mute` | write | Body `{ path, minutes }`. Returns `{ mutes }` |
| `POST /watch/unmute` | write | Body `{ path }`. Returns `{ mutes }` |
| `POST /watch/replay` | write | Body `{ duration?: "PT24H", paths?: [] }`. Returns `ok`, `from`, `to`, `resolutionSeconds`, `pathsReplayed` (asked for), `pathsEvaluated` (with any data), `pathsFailed?` (in requests that could not be read), `pathsSkipped?`, `rows`, `truncated?` and `rowsDropped?`, `historyGaps?`, `findingsOpened`, `incidentsOpened`, `byDetector`, `incidents`, `failures?`, `note`. With no rows at all (nothing recorded, or nothing readable) it returns only `ok: false` and a `message`, without `truncated`, `rowsDropped` or `note`. `409` while another replay runs |
| `POST /watch/rules/compile` | write | Body `{ text, path? }` (`path` pins the subject after a "which one?"). Returns `ok`, `source`, `model?`, `rule`, `description` (the rule as the alert it is), `reading?` (when a requirement was read as what is normal), `current`, `wouldFireNow`, `recent`; or `ok: false`, `reason`, `alternatives[]`, `assistNote?`, `assist?` (`off` when no model is set, `not-asked` when `ollamaUrl` is refused; `model` is then absent) |
| `POST /watch/rules/add` | write | Body `{ rule }`. Adds it, or replaces the rule with its id. Returns `{ rules }`; `409` when 50 watches already exist |
| `POST /watch/rules/remove` | write | Body `{ id }`. Returns `{ rules }`; `404` with `{ rules }` when no watch with that id is stored |
| `POST /watch/rules/save` | write | Body `{ rules: [...] }`, the full list, for tools that manage it as a unit. Invalid rules are dropped. Returns `{ rules }` |
| `GET /watch/report?hours=24` | | `from`, `to`, `hours`, `incidents`, `alerts`, `findings`, `byDetector`, `lines[]` |
| `POST /watch/feedback` | write | Body `{ path, useful }`: `false`, `true` or `"reset"`. Returns `{ path, factor }` |

The replay reads the History API with the same credential rules as the rest of
the plugin: the operator's session goes only to this machine, and a remote
history server needs `historyApiKey`. It replays up to 7 days, at least 10 s
per row, asking for at most 10,000 rows, for up to 80 paths in requests of
10. The row limit is enforced on what comes back, not only asked for: each
response is read oldest row first, and rows closer together than three
quarters of the requested resolution (apart from the first and last, which a
provider may clip to the window), outside the window (by more than one row)
or past a third more than the window holds are left out, and so are columns
for paths that were not asked for, a path's second column, and a column
that names no path (it is not guessed from its position; only a response
with no `values` list at all is read in the order the paths were asked). A
row with no value for any asked path is left out, so empty buckets a
recorder returns for its downtime count as a gap, and a response that
declares none of the requested paths is a failure, not a quiet history. Each
response is limited on its own, not against the others, so requests whose
rows fall at different times all keep theirs, and a row of a later request
within half a row interval of an earlier request's row joins it, so the
replay ticks once a row, not once per request. When rows were left out, the
result says so (`truncated: true`, `rowsDropped`, and a sentence in `note`),
so a provider that ignores the resolution cannot make a replay hold a week
of one-second rows, while rows with a little jitter are all kept. A replay
with no rows left at all (nothing recorded, or nothing readable) is no data
for the window: it answers only `ok: false` and a `message`, naming the
first failure if a request could not be read. A request that cannot be
read (an HTTP error, a body over 16 MB) is named in `note` (each distinct
reason once, with how many requests gave it: the first three, and how many
more) and counted in `pathsFailed`, and the panel shows how many
of the asked paths had data. A path asked for twice is replayed once.

Rows are an aggregate, so in a replay a path with a value in (nearly) every
row counts as regular even when the row interval is over a minute (a week's
replay has 61 s rows), and its dropouts are checked as they would be live. A
path that updates less often (every 90 s) is not regular live and is not
made so by a replay. The replay ticks the
detectors at each row and, through a gap in the returned history, at the row
interval up to the next row's time before that row is read, so a dropout or
a silent feed that spans the gap is reported as it would have been live.
Nothing is ticked past the last row: the history provider may not have
written the latest minutes yet. A gap of more than 10 minutes (or 10 rows)
where no replayed path has a row is counted in `historyGaps` (`count`,
`longestSeconds`) and named in `note`: nothing was recorded, which may be a
silent feed or the server or its recorder being off, which the live watch
never sees.

## Settings

The form on **Server → Plugin Config → Watchkeeper** opens with one switch,
**Turn on Watchkeeper** (`watchEnabled`), which is all most boats need; the
rest is grouped into sections, each a nested object in the plugin's options:

```json
{
  "watchEnabled": true,
  "alerts": { "watchNotifications": true, "watchSound": false },
  "watching": { "watchSensitivity": "normal", "watchLearningMinutes": 30, "watchDefaultExclusions": true, "watchExcludePaths": [], "watchCounterPaths": [] },
  "ruleAssist": { "ruleAssistEnabled": false },
  "replay": { "historyServerUrl": "", "historyApiKey": "", "historyProvider": "", "historyTimeoutMs": 30000 },
  "advanced": { "watchMaxPaths": 1500 },
  "watchRules": []
}
```

`readSettings()` in `lib/settings.cjs` turns that into the flat settings the
rest of the plugin reads. Inside a section a key keeps the name it had when
the settings were flat, and a key a section does not hold is read from the
top level, so options stored before the sections still work as they did.
The plugin's own writes (the watch rules) change `watchRules` only and keep
every section as it is.

**Settings saved by an earlier version are moved into the sections on the
first start, and shown in the form from the start even while the plugin is
off.** The admin page's form shows only what the sections hold, so
flat settings would appear as the defaults, and the form's first save would
put those over them. On start, the plugin therefore moves each flat setting
into its section, with its value unchanged, removes the flat key, and stores
the result once through the same write queue as the watch rules. A value
already in the section (written by the form) wins over the flat one. The
switch, the watch rules and keys the plugin does not know stay as they are.
Before the AI help had a switch, a model named meant on: a flat
`ruleAssistModel` becomes `ruleAssistEnabled: true` with that model, and a
blank one `ruleAssistEnabled: false`, with the blank dropped so that
switching on later offers the default model. A model already in the
section with no switch stored sets the switch the same way. The server log gets one line
naming the moved settings:

```
signalk-watchkeeper: moved settings saved by an earlier version into their sections: watchSensitivity, ollamaUrl, ruleAssistModel.
```

Nothing is stored when nothing is flat, which is every start after the
first. Nothing is stored while the plugin is stopped, either. If the server
cannot store the result, the plugin runs on the moved settings, which are the
same values, and the next start tries again.

A plugin that is off is not started, so its flat settings stay where they
are until it is turned on. The form shows them all the same: each time the
admin page loads the plugin's settings, the plugin reads the stored options
(`app.readPluginOptions()`) and makes each flat setting the default of its
field, so the form shows the stored value and a save stores it in its
section. The AI help switch is shown as the move would set it from the
model. A stored value the field does not take (outside its range or
choices, or of the wrong type) is not shown: the field keeps its usual
default, its description says so, and a save stores that default. Loading
the form writes nothing, and a server that cannot give the stored options
gets the usual form.

### Alerts (`alerts`)

| Setting | In the form | Default | |
| --- | --- | --- | --- |
| `watchNotifications` | Send alerts as Signal K notifications | `true` | Publish findings under `notifications.watchkeeper.*`, at `warn` or `alert` - never `alarm` or `emergency`, which belong to real alarm sources |
| `watchSound` | Sound on serious alerts | `false` | Add `sound` to the method of alert-level findings. Warnings are always visual only |

### What to watch (`watching`)

| Setting | In the form | Default | |
| --- | --- | --- | --- |
| `watchSensitivity` | Sensitivity | `normal` | How far from normal a value must move before it is reported: `low` (Calm – fewer alerts), `normal` or `high` (Sharp – more alerts); see the table under [Checks](#checks). Start at normal, and use the panel's replay to see what a setting would have raised over the last day before changing it |
| `watchLearningMinutes` | Learning period (minutes) | `30` | Minimum observation before a new path can raise anything (1–1440). The learned baseline is saved, so this is paid once, not after every restart |
| `watchDefaultExclusions` | Skip readings that move with the helm, wind and seabed | `true` | Skip the paths listed under [Skipped by default](#skipped-by-default): heading, course, speed, attitude, wind, depth, steering and similar change quickly by their nature. Position and fix quality are still read, by the GNSS integrity check |
| `watchExcludePaths` | Also skip these paths | `[]` | More paths or patterns to skip: a path covers everything beneath it, `*` matches within one segment, `**` across segments (`environment.inside`, `propulsion.*.exhaustTemperature`, `**.signalStrength`) |
| `watchCounterPaths` | Counters under other names | `[]` | Paths that only count up - engine hours, energy, pulses - under names the watch does not recognise (a plugin's own pulse or energy counter); they are not judged as levels or stuck sensors. Standard names (`runTime`, `fuel.used`, `lifetimeDischarge`, `energy…`, `log`, `…Today` and the like) are recognised already. A pattern covers the paths beneath it but not the measurements among them (a voltage, a level); list a path exactly to make it a counter regardless |

### Rules in your own words – optional AI help (`ruleAssist`)

Rules typed in the panel are read by the built-in parser, with no model. This
section only decides whether a request the parser cannot read is passed on to
a small model (see [Reading what the parser cannot](#your-own-watches-rules)).
Ollama is not part of the plugin: it is installed and run separately.

| Setting | In the form | Default | |
| --- | --- | --- | --- |
| `ruleAssistEnabled` | Use a small AI model for wordings the built-in reader can't handle | `false` | The opt-in. The two settings below are shown only while it is on |
| `ollamaUrl` | Ollama server address | `http://localhost:11434` | The Ollama server; blank is `http://localhost:11434`. A URL that is not http or https, has no scheme (`gpu.local:11434`), or carries a user name, password, query or fragment is refused: no model is asked, the compile answer says why, and so does the plugin status at start |
| `ruleAssistModel` | Model | `qwen3:0.6b` once the switch is on | A small Ollama model such as `qwen3:0.6b` or `gemma3:1b`. It picks from a short list of real paths, its answer held to a fixed format, and every result is read back for the operator to confirm. It is unloaded two minutes after use, so it does not hold GPU memory |

The help is on only when `ruleAssistEnabled` is `true` and `ruleAssistModel`
names a model; switched off, the address and model stay stored but are not
used. Options from before the switch have no `ruleAssistEnabled`: for them a
non-empty `ruleAssistModel` is on, as it always was.

### Replay from history – optional (`replay`)

| Setting | In the form | Default | |
| --- | --- | --- | --- |
| `historyServerUrl` | History server address | empty | Where the replay reads the History API; empty is this server, on localhost. Set it for history served by another Signal K instance (with its own `historyApiKey`). With TLS on, leave it blank and see [Servers with TLS](#servers-with-tls) |
| `historyApiKey` | History API key | empty | Bearer token for a history server that is not this Signal K server: another host, or another service on this machine at a different port. The operator's own session is forwarded only to this server (a loopback address on the port it listens on) - a cookie minted here is replayable against another Signal K instance - so anything else needs a credential issued for itself. Blank for this server's own history, or an unauthenticated one. Shown masked in the form |
| `historyProvider` | History provider | empty | A specific history provider plugin, for example `signalk-parquet`; empty is the server default |
| `historyTimeoutMs` | Wait per request (ms) | `30000` | How long each History API request of a replay (the path listing and each values read) may take. A value under 30000, 0 included, is taken as 30000: a replay always waits at least 30 s per request, and never without a limit |

### Advanced (`advanced`)

| Setting | In the form | Default | |
| --- | --- | --- | --- |
| `watchMaxPaths` | Most paths to watch | `1500` | Most paths watched (10–10000), a bound on memory and CPU. Paths beyond it are counted in the panel but not watched |

### Not in the form

| Setting | Default | |
| --- | --- | --- |
| `watchRules` | `[]` | Written by the panel, at the top level of the options |

## Replay and the History API

**Replay last 24 h** reads the Signal K History API: first the list of
recorded paths, then their values in requests of up to 10 paths. It needs a
history provider plugin (signalk-to-influxdb2, signalk-parquet, ...) recording
on this server or another one.

Three environment variables stand in for the settings:

| Variable | Stands in for | When |
| --- | --- | --- |
| `SIGNALK_WATCHKEEPER_HISTORY_URL` | `historyServerUrl` | the setting is blank |
| `SIGNALK_WATCHKEEPER_HISTORY_API_KEY` | `historyApiKey` | the setting is blank |
| `SIGNALK_WATCHKEEPER_HISTORY_TIMEOUT_MS` | `historyTimeoutMs` | the settings were never saved |

A number field cannot be left blank: once the plugin's settings are saved
from the admin page, a timeout is stored (its default, 30000, included), and
from then on the variable is not read.

### Which server gets your session

The History API is behind the same authentication as the rest of the REST
API, and a plugin has no session of its own. The operator who presses
**Replay** does: their cookie or bearer token arrives on that request and is
forwarded to the history reads, so a replay reads exactly the history that
operator could read themselves.

That holds only when the History API is this Signal K server. A cookie minted
here is replayable against another Signal K instance, so the session is
forwarded only to **this server**: a loopback address that reaches it, on the
port it listens on. The port is worked out the way Signal K picks it (the
listening socket itself is a server internal that plugins may not use):

- the HTTP port is `PORT` if set, else `port` in its settings, else 3000;
- with TLS on, the HTTPS port is `SSLPORT` if set, else `sslport`, else 3443.
  A blank `historyServerUrl` calls that port; the HTTP port carries only its
  redirect, and is neither called nor sent the session;
- only the value Signal K uses counts: with `PORT` set, a different `port` in
  the settings is not one of its ports, and the same for `SSLPORT`;
- under systemd socket activation (`LISTEN_FDS` set), which
  `signalk-server-setup` uses for every systemd install, systemd opens the
  listening socket and Signal K listens on none of its configured ports. The
  port is then the one Signal K advertises: `EXTERNALPORT`, which the setup
  script writes as the socket's own port (3000, 80, 3443 or 443), and for a
  hand-written unit without it, `proxy_port` or the configured port. The
  default 3000 does not count on an install whose socket is 80.

Outside socket activation, `EXTERNALPORT` and `proxy_port` are ports a reverse
proxy publishes, not ones this server listens on, and never count. Under
socket activation, a hand-written unit whose `EXTERNALPORT` names a reverse
proxy (nginx on 80 in front of `ListenStream=3000`) has the session sent to
that proxy, which hands it to this server. If something else answers on that
port, set `historyServerUrl` to the socket's own port and give it a
`historyApiKey` (a token issued by this server).

When no port of this server is known (a configured or advertised port that is
not a valid port), a blank `historyServerUrl` calls nothing rather than send
the paths and window to whatever holds a guessed port, and the replay says
why.

Another host, or `localhost` at another port (any other service on this
machine is on loopback too), is never sent the session. Give it a credential
issued for itself in `historyApiKey`, or leave that blank if it needs none.
When a key is configured and the server still answers 401 or 403, the replay
shows the server's own reason and says the key was rejected.

A `historyServerUrl` (or `SIGNALK_WATCHKEEPER_HISTORY_URL`) with a user name
or password in it (`http://user:password@host`), one that is not a valid http
or https URL, or one with a query or fragment (even an empty `?` or `#`,
which the API path would be appended after) is never called. The replay says
so without repeating the URL, so a password does not reach the panel; put a
token in `historyApiKey` instead.

On this server's port, `localhost`, `127.0.0.1` and `[::1]` all count. Signal
K listens without naming a host, and Node then binds the dual-stack wildcard
`::` (or `0.0.0.0` on a host without IPv6); a systemd `ListenStream=<port>`
socket binds dual-stack too by default. While Signal K holds the port that
way, no other process can hold `127.0.0.1` or `[::1]` on it. The exposure that
remains is a listener on one address family only: a socket unit with
`BindIPv6Only=ipv6-only`, or `net.ipv6.bindv6only=1` with the default
`BindIPv6Only=`, or one bound to an IPv4 address. Another service could then
take the other family's loopback on the same port. Avoid that combination, or
set `historyServerUrl` to the loopback address Signal K holds.

### Servers with TLS

With TLS on, a blank `historyServerUrl` calls `https://localhost:<port>`. Node
does not trust Signal K's generated certificate, so that call fails with
`DEPTH_ZERO_SELF_SIGNED_CERT` until it is told to:

- Signal K's generated certificate (`ssl-cert.pem` in its configuration
  directory, normally `~/.signalk`) is issued to `localhost`, so starting
  Signal K with `NODE_EXTRA_CA_CERTS` pointing at it makes
  `https://localhost:<port>` verify. In a systemd install, add
  `Environment=NODE_EXTRA_CA_CERTS=/home/<user>/.signalk/ssl-cert.pem` to the
  service (`systemctl edit signalk`) and restart it. `https://127.0.0.1` still
  fails (`ERR_TLS_CERT_ALTNAME_INVALID`): the certificate names only
  `localhost`;
- a certificate of your own: add its issuer to `NODE_EXTRA_CA_CERTS` the same
  way, and call a name it is issued to. A name that is not a loopback address
  is not this server as far as the session goes, so give it a
  `historyApiKey`.

A failed call names its cause (`fetch failed: ECONNREFUSED`, `fetch failed:
DEPTH_ZERO_SELF_SIGNED_CERT`, ...), and a rejected certificate comes with this
advice.

### Response size and time

A History API response is read up to 16 MB (a declared larger
`Content-Length` is refused without reading), and an error body at most 4 kB.
The plugin runs in the Signal K server's own process, so a provider that
ignores the requested resolution cannot exhaust its memory: the replay says the
response was too large instead. Each request waits `historyTimeoutMs`, at
least 30 s, so a provider that never answers ends the replay with a message
rather than leave it running.

## Persistence

The learned state is saved to `watch-state.json` in the plugin's data directory
every 5 minutes and when the plugin stops. It is written to a temporary file
and renamed, so a crash cannot leave half a file. The saved state includes each
path's baseline, series, discrete states, per-state baselines and source
statistics, plus recent incidents, the finding log for the report, operator
feedback, mutes and the current operating states.

On start, a saved state younger than 14 days is restored. Every path's
last-seen time is reset to now, so the gap while the plugin was down is not
reported as dropouts or failovers. About 1.2 MB per 1,000 paths.

**A restart is not news.**

**How long each source takes to come back is learned** (`lib/watch/restarts.cjs`).
Every plugin announces itself again at its own pace: a GNSS receiver within
seconds, a Bluetooth plugin after it has scanned for its sensors, an
under-keel plugin once it has a depth. For each source, the watch keeps how
long its paths took to be heard again (a second reading - the first may be
the server's cached value) and how long its state paths took to come back
from their detour, over its last 8 restarts. The windows below are half
again the longest of those, 1 to 60 minutes; until a source has been
through a restart, the defaults given here hold. The inventory lists them
(`restarts`).

- *Open findings carry over.* After a restart within 30 minutes of the last
  save, a finding that was open is the same finding if its condition is back
  within 20 minutes, or the slowest source's time to be heard again and 5
  minutes more, once that is learned (longer than paths are given to be
  heard again, below;
  back in time means its condition was first active again by then, even if
  its persistence ends after): opened when it first opened, in the same incident,
  counted once in the report. Its notification is raised again, because the
  server's went with the restart. One that does not come back is closed as
  of the restart, and its incident is marked *plugin restarted*. After a
  longer time down, incidents that were open are closed at once, as before.
  Either way, a finding the restart closed is in the report's log.
- *Start-up settles for 2 minutes* - for each path, once learned, its
  source's usual time to be heard again and 2 minutes more (a link
  reconnecting spikes its round-trip time once it is heard); for what is not
  one path's (gates, the feed, GNSS), the quicker sources' time and 2 minutes,
  never less than 2. Every plugin announces its values again when the server
  starts, and some pass through another state on the way (a link that reads
  "down" until it has connected). Meanwhile,
  switches are not counted toward cycling; a value never seen before is a
  new state only if the path still holds it when they are over; an
  operating state that changes is applied once, as it stands at the end;
  and no new finding opens (a link's round-trip time while it reconnects),
  except your own watches and findings carried over the restart - what is
  still there at the end is reported then.
- *State paths follow their restart detour.* Some plugins take minutes to
  settle (an under-keel plugin reads "off" until it has worked out its
  first clearance). Until a state path is back on the value it had before
  the restart, for 15 minutes at most (its source's learned detour, once
  known), its switches are not counted and a
  value first seen then waits. Back on it, nothing on the way was news; not
  back by then, it is one change (and a new state, if the value is new). A
  restart during a detour keeps the value from before the first.
- *Habits are not learned from restarts.* Nothing is added to a path's
  habits during the start-up, and a departure that began then is the
  restart's until it ends, however long it fades afterward. An episode in
  progress at a restart within 30 minutes of the save carries on as one.
- *Paths are reacquired.* A path that has not read again since the
  restart (a Bluetooth plugin may take minutes to hear its sensors again,
  sending "no value" meanwhile) is not reported as a dropout until it has,
  or for 15 minutes - its source's learned time, once known, so a dead
  sensor on a source that is back within seconds is reported within minutes.
  Until it is learned, a feed that is dead when the server starts is
  reported up to 15 minutes later than one that dies while running.
- *"No value" keeps its start.* A sensor sending `null` when the plugin
  stopped is still said to have had no value since then; its dropout still
  counts from the restart.

## Measuring it on your own data

Two scripts measure the watch on a boat's real data, which is how every
change to the detectors should be judged:

- `node scripts/record-stream.mjs <out.ndjson> [ws://host:3000]` records a
  Signal K server's stream - a line per delta with the time it arrived, and
  the server's restarts - for as long as it runs.
- `node scripts/evaluate-recording.mjs <recording.ndjson> [--state watch-state.json]`
  injects known faults into the recording (steps, drifts, frozen senders,
  dropouts, each on a path whose own data can show it; `--faults`, `--seed`,
  `--size`), replays it through the engine as the plugin feeds it, with an
  engine restart wherever the server restarted, and reports which faults
  were found and how fast, and every other finding per hour. `--lib` picks
  the version to measure and `--fault-lib` the one whose exclusions choose
  the fault paths, so two versions can be compared on exactly the same
  faults; for a missed fault it says what the watch made of the path
  halfway through it.

On 8.6 hours of a moored boat's data with 13 real restarts, over six sets
of 24 faults of 8 spreads: dropouts 36/36 found, frozen senders 34/36,
steps 30/36, drifts 26/36 - a slow drift is the hardest, as the baseline
follows part of it - and 0.8-0.9 other findings an hour, all of them two
real degradations of a radio link and a camera's frame-rate dip.

## Tuning

1. **Start at `normal` and let it learn.** The first 30 minutes per path are
   learning, and operating states need to be visited once (engine run, charger
   cycle) before their baselines can be restored.
2. **Replay before changing sensitivity.** Once a history provider has a day of
   data, **Replay last 24 h** shows what the current settings would have
   raised. History is aggregated and smoother than live data, so read the
   result as a lower bound.
3. **Exclude, do not desensitise.** If one path is noisy by nature (a sensor
   that hunts, a value driven by the helm), add it to `watchExcludePaths`
   rather than lowering sensitivity for everything.
4. **Mute for a known situation; say "Not useful" for a noisy path.** **Mute 1 h**
   silences a path you know about (a deliberate test, a fault being worked on).
   **Not useful** tells the watch the finding was not worth the interruption,
   so that path needs a bigger change next time. Both count as feedback when
   the path is firing, and **Restore** undoes it.
5. **Write a rule for a hard limit.** The statistics find what is unusual for
   this vessel. A rule states what is not acceptable, whatever is usual.

## Performance

Measured on an x86 development machine with 1,000 continuous paths at 1 Hz:

| | |
| --- | --- |
| Per update | ≈ 3 µs |
| Per 5-second check, all paths | ≈ 2 ms |
| CPU at 1 Hz × 1,000 paths | ≈ 0.3 % of one core |
| Saved state | ≈ 1.2 MB |

An ARM board (a Raspberry Pi, a Cerbo GX) is a few times slower, which is still a small fraction
of one core. No GPU is used.

## Limitations

- **Thresholds are tuned on simulated data.** The defaults come from the test
  scenarios, not from a fleet of real boats. Use the replay on your own data
  before trusting them.
- **Dead reckoning allows 2 kn of current.** In a stronger tidal stream, the
  dead-reckoning indicator can warn falsely. A second indicator is needed
  before anything escalates to `alert`.
- **Learned operating states need a few occurrences.** A watermaker or
  generator nobody named is reported the first few times it moves other
  paths, until the pairing is significant (about four times, for one that
  runs every two hours). A pair once learned is kept; one learned from a
  coincidence would keep re-learning its path after each change of its
  driver.
- **Slow drifts are the hardest to catch.** The baseline follows part of a
  drift that takes half an hour or more, and a drift that stays within a
  few of the path's own spreads may go unreported.
- **Habits are only as good as their history.** A path that has a fault every
  few hours for days learns to expect it. The first ones are always reported,
  the report lists what is expected, and "useful" makes the watch forget.
- **Replay uses aggregated history,** which is smoother than live data, and
  replays at most 80 paths. Paths that rules read go first; only rules
  reading more than 80 paths in all could lose one.
- **The rule parser knows English phrasing** and a fixed list of synonyms.
  Other languages fall through to the model, if one is configured.

## Source map

| File | |
| --- | --- |
| `lib/watch/engine.cjs` | Config, exclusions, operating states, tracker, findings, incidents, inventory, rules, export/import |
| `lib/watch/path-monitor.cjs` | Per-path learning and the per-path checks |
| `lib/watch/habits.cjs` | The departures each path makes and comes back from, and how far is news |
| `lib/watch/drivers.cjs` | Operating states learned from which changes other paths answer |
| `lib/watch/restarts.cjs` | How each source comes back after a restart |
| `scripts/record-stream.mjs`, `scripts/evaluate-recording.mjs` | Record a server's stream; measure the watch on it with injected faults |
| `lib/watch/sun.cjs` | The sun's elevation from a position and a time |
| `lib/watch/gnss.cjs` | GNSS integrity indicators |
| `lib/watch/sources.cjs` | Primary source, disagreement, failover |
| `lib/watch/rules.cjs` | Rule format, validation, evaluation, plain-language description |
| `lib/watch/rule-parser.cjs` | Plain language → rule, without a model |
| `lib/watch/rule-assist.cjs` | The schema-constrained model fallback |
| `lib/watch/narrate.cjs` | Finding text from templates |
| `lib/watch/format.cjs` | Operator units, path names, unit parsing |
| `lib/watch/stats.cjs` | Exponential averages, distances, trends |
| `lib/watch-service.cjs` | Signal K wiring: subscription, notifications, persistence, replay, rule compilation |
| `lib/history-service.cjs` | History API client for the replay: server resolution, credential scoping, bounded reads |
| `index.cjs` | The plugin: settings, routes, stored rules |
| `src/AppPanel.tsx`, `src/WatchPanel.tsx`, `src/watchText.ts` | The panel and its helpers |
| `test/*.test.cjs`, `src/watchText.test.ts` | Tests |
| `scripts/preview-host.mjs --demo` | A scenario to see it working without a boat |
