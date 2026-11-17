# Changelog

All notable changes to `signalk-watchkeeper` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/).

## [0.3.0]

What the watch tunes to a boat is now learned from that boat's own data,
not from path names or fixed windows, and how well it does can be measured
on a boat's own recording.

### Added

- **Operating states learned from the data.** Any path that changes state
  (a discrete path's value, a gate's regime, the sun) and is followed by
  departures on another path far more often than chance - a binomial test
  against how often it changes at all - becomes that path's operating
  state: a watermaker, a generator or a plugin's own mode, with no name
  needed. How long the answer takes is not assumed: the test is made over
  one, five and twenty minutes, the significance shared between them. The
  named gates stay as priors and gain what is learned. Listed in the
  inventory (`learnedStates`).
- **How far a path's average usually strays is learned, and departures are
  measured by it.** A departure was measured in the spread of the path's
  readings; it is now measured by how far its last few seconds' average
  strays from its baseline when nothing is happening - much less than the
  readings' spread for a sensor whose noise averages away, about the same
  for one whose readings wander together. Steps and drifts that hide in a
  noisy sensor's scatter are found; a slowly wandering one is not reported
  for its wandering. The finding still gives the size in the readings'
  spread, and says how far its average usually stays when that is much
  less. A saved path is judged as before until its yardstick has learned;
  habits are kept as before.
- **How each source comes back after a restart is learned**: how long its
  paths take to be heard again and its state paths to come back from their
  detour - one observation per restart, the last 8 kept, each fitted as the
  habits are, so a source that always takes ten seconds is given little
  more and an erratic one well more - and how long each path's own
  departures after a restart take to settle (a link's round-trip time while
  it reconnects; to when each ended, also within the start-up, once per
  restart), so its start-up allows for them and its source's other
  paths' does not. Each path's start-up, reacquiring and detour, and how
  long carried findings wait, follow from it; the fixed windows are only the
  defaults until then. Listed in the inventory (`restarts`).
- **Habits of level changes**: a departure accepted as the new normal (a
  daily figure stepping at midnight, a setpoint moved) is kept as a habit,
  so its next steps of that size are routine.
- `scripts/record-stream.mjs` and `scripts/evaluate-recording.mjs`: record a
  server's stream, and measure the watch on it with injected faults,
  comparing two versions on the same faults.

### Changed

- **How far past its habits a departure must go is fitted to the path**: its
  episodes' peaks and lengths as log-normal, shrunk toward a prior while
  there are few, against an alert budget the sensitivity sets (about one
  routine episode a month per path at normal), and never past the path's
  own record by more than its own scatter. Replaces the fixed 1.5 times the
  80th percentile and "twice as long and 5 minutes more".
- **Counters by behaviour, not by name**: a path that only climbs through a
  whole day of watching is a counter, as is one that showed a reset. The
  names added in 0.2.0 for one boat's paths (`usage.rx`, `…Bytes`,
  `…Packets`, `…Retransmissions`, `sequenceNumber`) are gone.
- **A whole-number path is a state code only if it behaves like one**: a
  value it never had is a new state on its first change, for a path named
  as a state code, or once it has gone back to a value it had before.
- `**.*Yesterday` is no longer a default exclusion: such figures are learned
  as habits of level changes.
- A departure's text gives its last few seconds' average, with the last
  reading beside it, when the two disagree: "high" is no longer said of a
  last reading that is already back below its usual.

### Fixed

- **An incident is named and rated by what is still open.** It was named
  after its first finding and kept the worst severity it ever had, so a
  day-old incident whose alerts cleared within the hour still read *Alert:
  Navigation under keel state switching unusually often (+17 related)*.
  While active it is now named after its earliest finding that is still open
  (or the one that reopened it, while that is open) and rated by the worst
  open finding: the same incident reads *Navigation under keel clearance has
  no value (+N related)*, as a warning. A resolved incident keeps the name it
  had last and is shown at the worst it reached, now kept as `peakSeverity`;
  the watch report counts an incident that reached alert as an alert. The
  notifications on `notifications.watchkeeper.*` already followed each path's
  open findings, and still do.
- **An incident no longer takes in everything while it stays open.** A finding
  joined an active incident if its system had ever had a finding in it, or
  within 3 minutes of the incident's last new finding, so two sensors with no
  value held one incident open for 22 hours and took in a vision system's
  frame rate an hour later and the Nano's disk, memory and CPU temperature
  over the night and day after. A finding now joins by timing only while the
  incident is forming - within 3 minutes of its last new finding, and no later
  than 10 minutes after it opened, so a cascade still forms one incident - and
  by system only while that system still has an open finding in the
  incident, which it then joins before any other. GNSS findings still group
  only with GNSS findings. Saved incidents load as before; an active one
  carried over a restart is renamed and rated by what is open.
- A baseline is no longer filed under an operating state while the path is
  in the middle of a departure; filed then, the state's own level came back
  as a departure every time the state did.
- A path heard again only long after a restart (a connection unplugged for
  a day), or one that reports only now and then, no longer widens its whole
  source's window after restarts (CodeRabbit's review of 5d015da).
- A restart's own switches (a plugin sending 0 until it has read, then its
  5 again) are not taken for the path going back to its states, and a
  first change made during the start-up is reported as it would be outside
  it (CodeRabbit's review of 5d015da).
- A counter's day of climbing counts only the time it was watched climbing,
  not the hours the plugin was down (CodeRabbit's review of 5d015da).
- A source or path named `__proto__` is kept as any other
  (CodeRabbit's review of 5d015da).
- One path changing every second no longer fills the operating-state
  learning's memory of recent changes: each path's latest change is kept.
- The evaluation script collects findings as it goes, watches the silence
  before a recorded restart, puts faults only where their path reads, and
  carries on when one kind of fault fits no path
  (CodeRabbit's review of 5d015da).

## [0.2.0]

The watch now learns from each path's own history, beyond its baseline. On a
moored boat's first day the earlier version raised 50 incidents from 128
findings, nearly all of them the patterns below; in a three-day simulation of
those patterns, findings fell from 59 to 9 and every real fault in it was
still reported.

### Added

- **Habits.** A path that keeps making the same kind of departure and coming
  back from it on its own - a radio link's packet loss spiking for a minute,
  a solar charger flapping at dusk - is reported the first few times, then
  only when it goes more than 1.5 times further, or lasts more than twice as
  long, than it usually did (3 episodes over 6 hours make a habit; 14 days
  are kept). The finding says what the path usually does, the watch report
  lists what it has learned to expect, and "useful" makes it forget.
- **Counting unusually fast** (`rate`). A counter is watched by how fast it
  counts: four times the fastest 10 minutes of the past week is reported.
- **Day, twilight and night** as an operating state of `electrical.solar.`,
  worked out from the vessel's position and the time, with no sun path or
  other plugin needed. Solar paths re-learn through twilight; the night's
  baseline is restored each night.
- **Counters that show themselves by a reset.** A path no name says is a
  counter, that drops to zero and counts up again from there and never goes
  down otherwise (a link's sequence number, a modem's byte count), is a
  counter; so is one reset to a lower value after a long unbroken climb. A
  climb alone still is not. Byte, packet and retransmission counts,
  `usage.rx`/`usage.tx` and `sequenceNumber` are recognised by name.
- **Spells of "no value"** a sensor keeps coming back from become a habit,
  like the departures above.
- `…Yesterday` figures are a default exclusion: they change at midnight by
  design.

- **A restart is not news.** A finding open when the plugin stopped carries
  on as the same finding, in the same incident, if its condition is back
  within 20 minutes of a restart (and the save is under 30 minutes old). For
  the first 2 minutes after start, states that plugins announce again are not
  counted as switching, a new state must still hold when they are over, an
  operating state is applied once, as it stands then, and no new finding
  opens (your own watches excepted) until they are over. A state path's
  switches are not counted until it is back on its value from before the
  restart (15 minutes at most), as some plugins take minutes to settle; how
  long a sensor has had no value is kept across a restart. Habits are not
  learned from a restart's own departures (a link reconnecting), and an
  episode a short restart cut in two stays one. A path that has not read
  again since a restart is not a dropout for its first 15 minutes.
- **A flapping operating state waits.** A gate that changed more than 4 times
  in the last hour is applied only once it has held one state for 10 minutes,
  so a charger hunting between modes does not keep the electrical paths
  re-learning all day.

### Changed

- The charger, inverter and alternator gates also match the singular names
  (`electrical.charger.<id>.chargingMode`).
- **Stuck sensors are judged by how long the path itself holds a value**, per
  operating state, instead of by how often it changes. A counter that ticks
  in bursts, or a stopped engine's temperature sitting on one reading for an
  hour, is no longer stuck; a freeze while the engine runs still is. A hold
  is judged only against enough of the path's history: six times the limit
  in learned runs, and a day of them for a limit above 5 minutes.
- **Measurements are never state codes.** A whole-number signal strength
  (`rssi`, `rsrp`, `rsrq`, `sinr`, `snr`, dB, dBm), jitter, latency, loss or
  any path with a measurement's name or unit is continuous, so a new reading
  is not a "new state". Saved paths decided discrete move with their next
  sample.
- **`null` is "no value"**, not a state: a sensor briefly sending null is not
  reported, and one that keeps sending it is reported as having no value.
  Saved states forget `null` as one of their values.

### Fixed

- One bad position fix between good ones from the same source (an AIS
  transponder's own position, rounded, as it starts) is no longer a GNSS
  jump: a jump waits for the source's next fix, and one that is back where
  the vessel was is the bad fix, not the vessel.
- A reading its sender rounds (disk use sent as 0.29, then 0.3) is judged
  with the rounding step as its noise floor, learned from the decimals it
  is sent with at its baseline, before a step has been seen three times.

- The noise floor of a path that sits at zero collapsed to 1e-9 once its mean
  had decayed to a tiny non-zero value after a spike, so rounding noise read
  as thousands of spreads and kept the finding open. While the mean is within
  the path's resolution of zero, the resolution is the floor.
- A counter's reset is no longer reported as a level drop while the next
  samples show it counting up again (up to 6 hours for a slow count).
- A counter that was once reset to a value other than zero was taken for a
  measurement for good; saves learn again whether each path falls.

## [0.1.0]

First release as its own plugin. Watchkeeper was developed inside
`signalk-ai-bridge` and moved here unchanged in what it detects; what changed in
the move is listed under **Changed**.

### Added

- **A background watch of every Signal K path, with no language model.** Off
  by default (`watchEnabled`). It subscribes to every self-vessel path, learns
  each one's normal behaviour, and raises Signal K notifications for:
  - sustained steps and ramps away from the baseline;
  - sensors that stop updating or freeze, and a data feed that goes silent;
  - discrete values never seen before;
  - pumps cycling unusually often;
  - tanks, batteries and zoned values trending toward their limits;
  - GNSS positions that dead reckoning, a second receiver or the fix's own
    quality do not corroborate;
  - redundant sources that disagree, and failover between them.
- **Operating states.** When an engine starts or a charger changes mode, the
  affected paths re-learn, or restore the baseline they had in that state,
  instead of alerting.
- **Incidents.** Related findings are grouped, earliest sign first, with text
  from templates, so every number in it is a measured one.
- **Your own watches.** Rules written in plain words, read by a built-in
  parser and read back before they are stored; numeric comparisons with a
  duration, on/off and other states, changes, and one "while" condition.
- **Feedback, mutes and a watch report.** "Not useful" raises a path's bar;
  mutes silence a path for a while; the report says what the watch saw.
- **Replay.** A fresh watch over recorded History API data, saying what it
  would have raised, to judge sensitivity before it interrupts anyone.
- **The learned baseline survives restarts** (`watch-state.json` in the
  plugin's data directory).
- **A panel** in the admin UI: findings and incidents with sparklines, rules,
  mutes, feedback, the inventory of watched paths, "most unusual now", the
  report and replay.

### Fixed (from CodeRabbit's review of the import)

- **An admin is no longer told the login is read-only.** The panel took the
  admin UI's `readOnlyAccess` for the login's level, but it is the server's
  "Allow Readonly Access" setting (reads without a login). The panel and the
  plugin's write check now read the login's own level, `userLevel`.

- An operating state on a path the watch does not baseline (excluded, or
  past the cap on watched paths) is read from the source seen first too: a
  second source's first sample no longer takes over as its primary. That
  source keeps its sample count and interval, so a failover from a source
  that had sent alone for long is reported, and one that reports every 30 s
  keeps its place when a faster source appears. Other paths past the cap
  are not compared across sources, and take no room in the tables kept for
  skipped paths. That interval leaves out an outage, as a watched path's
  does, and is each source's own: an hour's silence before a failover no
  longer makes a 1 s source wait minutes to take the primary (and the
  operating state it gates) back, and a new primary is judged by its own
  interval (from its next sample if it has none yet), not by the old
  primary's - a 20 s source that took over from one that slowed to 45 s
  keeps the primary instead of failing back and forth.
- Every request's error reply body is waited for at most 2 s by the fetch
  wrapper itself, also with no timeout set and when fetch ignores the
  abort, and such a body ends as a timeout rather than as an empty reply.
  An error body nobody reads releases the caller's abort listener when its
  2 s are up, and a long body is read in constant memory. A body that ends
  (whole, failed or cancelled) stops watching the request's abort.
- A rule add redone after a restart that left no room, then one that did,
  is answered as stored, not "already 50 watches"; and a save the plugin
  was stopped during says what is stored (the change, or the options it
  restarted with). A rule add, remove or save that the plugin stops right
  after storing answers 503 saying the change was saved, so it is not made
  again, instead of the stopped plugin's lists or a plain "stopped" - also
  when the save was redone after a restart that had loaded the change
  already, so the redo had nothing left to write. A rule sent without
  `createdAt` is stamped once per change, not on every attempt: a redo a
  millisecond later no longer finds a different list and writes it again.
- Error text keeps the host that failed when a URL is followed by a quote,
  a bracket or a backslash and a later `@`, and an `@` after `//` inside a
  path is kept.
- The manual copy box selects its text again on the tap that follows focus
  (iOS).
- "Not above 95 °C", "not below 12 V" and "does not exceed" are read as
  their opposite (`atMost`, `atLeast`), in a rule and in its guard; "not
  above" was stored as `above`. A limit said with "should not", "must not",
  "may not" and the other modal forms keeps its comparison, like "never" and
  "shouldn't" ("should not exceed 14 V" is `above` 14, not `atMost`), also
  with the modal before the "not" ("should be not above 14 V", "must be not
  below 12 V" and "needs to stay not above 14 V" are read as "should not be
  above 14 V": `above` 14, with "should be" no longer left in the subject;
  it was `atMost` 14, an alert while the voltage was normal); "no
  higher than" is `atMost` and "no lower than" `atLeast` (they were `above`
  and `below`), as are "no hotter, warmer or faster than" (`atMost`) and "no
  colder, cooler or slower than" (`atLeast`); and a comparison negated twice
  ("not not above", "is not no higher than", "never goes no higher than") is
  refused. A requirement without "not" ("should be below 14 V", "must stay
  above 12 V", "needs to be at least 20 %", with should, must, shall, needs
  to, has to or ought to) says what is normal, so the rule alerts on its
  opposite (`atLeast` 14, `atMost` 12, `below` 20): "should be no higher than
  14 V" alerts above 14 V, like "should not exceed 14 V", instead of while the
  voltage is normal. The read-back says so, quoting the words as written
  (verb and case kept: "must stays above 12 V", not "must above 12 v").
  A modal about the comparison in a request that also says when to alert -
  "if", "when", "whenever", "in case" or "once" anywhere before it, whatever
  the punctuation - is refused: "alert me if the battery voltage should be
  below 12 V" may mean below 12 V or what is normal, and trivial rewordings
  ("alert me, if", "please, tell me if", "send me an alert if", "when ...
  should be below 12 V, tell me") no longer flip the rule between the two,
  nor do "should be at least", "should be no higher than" and "should not
  exceed" there give opposite rules. The refusal offers one plain phrasing
  for each reading ('Say "alert me if battery voltage is below 12 V" or
  "alert me if battery voltage is at least 12 V"'), quoting the condition
  without the "warn me" after it. A "tell me", "alert me" or "let me know"
  after a requirement with none of those words before it only says how to
  be told: "depth should be at least 3 m, warn me" is below 3 m, and "coolant
  must stay below 95 °C, tell me" at least 95 °C, as without it. A
  condition said before the subject ("when the engine is running battery
  voltage should stay above 12 V") is refused with the "while" to say
  instead. "Once", "when" or "if" in a name on the vessel ("the once
  battery") is no condition there. A "while" right before a clause makes it
  the "while" wherever it stands: "alert while the engine state is on if
  coolant is above 95 °C" watches the coolant, not the engine state. "May", "can", "will" and the
  like as a modal without "not" (with a verb after it, or before "exceed"),
  a requirement with a verb of crossing ("should drop below 12 V", which may
  be the alert itself) and a requirement in a "while" are refused as
  ambiguous, with the same phrasings - in a "while", the condition said
  plainly in the request's own words ("while battery voltage is below
  12 V", "while the engine revolutions are above 600 rpm"), as a "while" is
  no alert; so is a limit said with a modal or "never" in a "while" ("while
  the engine revolutions should not exceed 600 rpm" was read as while they
  are above 600 rpm), with both conditions offered; such refusals, like a comparison negated twice, are not passed to
  the model, which is told that such requests say neither side - also when
  the refused comparison is joined to another ("coolant above 95 °C and
  battery voltage may be below 12 V" is refused with that comparison's own
  reason, not passed on as trailing words). A "can"
  that is no modal ("jerry can below 20 %", "the jerry can is below 20 %",
  a path named "Jerry can") is part of the subject.
- An operating state (engine running, charger mode) is read from its path's
  primary source only: a second source reporting another value no longer
  flips it on every sample and keeps the paths it gates relearning.
- A sensor whose gaps grew before it went silent for good is still reported
  (after an hour's silence, or 1.5 times its longest gap): unconfirmed long
  gaps no longer end its watch, nor does a confirmed slower rate: a path
  that reported every 10 s and then settled at every three hours (eight
  gaps of about one size) is still watched at that rate, for ten of its
  intervals but a day at most, or 1.5 times its longest gap, and is
  reported a day after it stops (it was not watched at all). Its regular
  interval is updated by regular gaps only, so random gaps of 2 to 40
  minutes no longer raise it until a
  dead sensor goes unreported. Such a path no longer counts toward the data
  feed's steady paths while it reports, so a gateway that goes down with
  regular and raised paths behind it is reported as one silent feed at once,
  not as separate dropouts an hour later. One short gap after the interval
  rose (a second reading a second after a long gap) no longer copies the
  raised interval into the regular one, which hid the sensor's death for
  good. An outage that ended while the path was still regular counts as
  two hours at most, and is forgotten when the path settles regular again:
  a sensor unplugged for two days, back, slowed and then dead is reported
  after about an hour (under three if it came back slow at once), not after
  three days. A gap of up to a day that ended while the interval was already
  raised is the sender's rhythm and is kept across a regular day: a sender
  that reports every 10 s by day, every few minutes in the evening and not
  at all at night is reported on its first night, not every night. A longer
  one is an outage too, however slow the path was: a slow sensor unplugged
  for two days, back and then dead is reported after about an hour, not
  after three days. A save from before keeps no longest gap on a path that
  has settled regular (one of an hour and a half no longer sets the limit
  for good), and no save keeps one of more than a day as the rhythm.
- A silent data feed is paths that went quiet together, on connections with
  nothing still reporting: raised paths that die over a night while steady
  ones report are their own dropouts, not one "Signal K data stopped
  arriving" that folds them in; a raised path that reports counts as live;
  paths that went quiet an hour before the rest keep their own findings; and
  half the vessel's devices going quiet while every connection still reports
  is their dropouts, while one connection (`can1`) going quiet as a whole is
  a silent feed. Live takes evidence: a sample later than the path's own
  interval after the rest went quiet, or two samples since, from a path that
  is not overdue - a 55 s path whose last sample came 12 s after a gateway
  stopped, or a raised path seen in those seconds, no longer holds the feed
  back for minutes or an hour while every other path is reported on its
  own. While a slower path on the connection is due but has not shown
  either way, the connection is undecided: neither the feed nor its silent
  paths' dropouts are reported until that path proves live (its paths'
  dropouts, at once) or misses its next sample (1.5 times its interval; the
  feed, and no dropouts), and for two minutes after that connection's paths
  went quiet at most - a path elsewhere that dies later does not start the
  wait again. A connection is live by what it sent after its own paths went
  quiet: a 55 s path on `can0` that reports twice after `can0`'s paths
  stopped, but not yet twice after `can1`'s stopped a minute later, no
  longer leaves a "16 of 17" silent feed until its next sample; `can0`'s
  paths are dropouts, and `can1` is a silent feed of its own. A raised or
  cycling path that is past its own due time (1.5 times its gap) is not
  waited for: a gateway that dies with one on it is
  reported in 30 s, not 5 minutes. The feed alert comes up to one slow
  interval, at most two minutes, later (95 s rather than 30 s with a 55 s
  path that sent once after the rest stopped), and no longer opens and
  clears into the paths' dropouts a minute later, which split one event
  into two incidents; a finding that opens in the tick an incident resolved
  joins it again, and names it: a silent feed that cleared into its paths'
  dropouts no longer leaves an incident titled "Signal K data stopped
  arriving" while data arrives. Only the newest moments that enough paths share to be a
  feed are judged, so a vessel with thousands of paths that died one by one
  no longer costs seconds every tick. The group that went quiet most
  recently is the feed, not an older and larger one (whose connection may
  even be live, which left no feed at all): a group dead for an hour keeps
  its own dropouts and is left out of the count, so the gateway that dies
  now is reported, with its own sources; and a second connection going
  quiet joins a feed silence already reported. A muted silent path counts
  toward the feed only if its silence may have begun with the unmuted
  paths' (the test they pass): ten muted paths that went quiet an hour after
  four unmuted ones did are no "14 of 18" silent feed, and the four keep
  their dropouts. A connection is the label the server gives the source
  (`update.source.label`: `can0` for `can0.115`, `venus` for every device of
  the Venus plugin, so one Venus device dying while the others report is its
  own dropouts, not a silent feed), kept with the path across a restart;
  without one (a replay), everything before the source's last dot
  (`n2k.can0` and `n2k.can1` are two).
- A rule whose value or guard is edited waits its full duration again, like
  one moved to another path; a "changes" rule whose guard or value is edited
  does not report the change it already reported again.
- A "changes" rule whose value went stale does not report the same change
  again when the value comes back.
- A model's answer with an incomplete guard is refused instead of becoming a
  rule without one.
- An incident kept active by one open finding keeps at most 50 findings: a
  neighbour that clears and recurs no longer grows it without end. Its title
  still counts the findings dropped (*+120 related*, not *+49*), and the
  panel and the copied incident text say how many earlier findings are not
  shown.
- A malformed metadata entry, or a bad value on the stream bus, is recorded
  as an error instead of costing the rest of the delta.
- Replay releases the body of a request it could not read, and an error
  reply whose body stalls no longer holds the replay for good (its body is
  waited for 2 s).
- The panel ignores a status poll that answers after a newer one.
- CI runs the smoke test on the built panel too.

### Changed (in the move from signalk-ai-bridge)

- **Licensed under the European Union Public Licence v. 1.2 (EUPL-1.2)**
  (`LICENSE` and `package.json`), not the Apache-2.0 of signalk-ai-bridge.

- The plugin id is `signalk-watchkeeper`, and routes are under
  `/plugins/signalk-watchkeeper/watch/...`.
- Notifications are published under `notifications.watchkeeper.*` (they were
  under `notifications.aiBridge.watch.*`).
- **The settings are grouped into sections**, written for a boat owner
  rather than a developer: one switch, **Turn on Watchkeeper**, then
  **Alerts**, **What to watch**, **Rules in your own words – optional AI
  help**, **Replay from history – optional** and **Advanced**, each a nested
  object in the plugin's options (`alerts`, `watching`, `ruleAssist`,
  `replay`, `advanced`) with short plain descriptions; the technical detail
  moved to the settings section of `docs/watchkeeper.md`. Sensitivity reads
  Calm – fewer alerts / Normal / Sharp – more alerts, stored as `low`,
  `normal` and `high` as before. Options stored flat are still read
  (`lib/settings.cjs`), and saving a watch rule keeps every section as it is.
  Settings saved by an earlier version are moved into the sections on the
  first start (`migrateSettings()`), and shown in the form from the start
  even while the plugin is off, so the form shows the stored values
  instead of defaults that its first save would have put over them. A value
  already in a section wins, the flat keys are removed, and a flat model
  becomes the AI help switched on with that model (a blank one, switched
  off). The result is stored once through the options write queue, and the
  server log gets one line naming the moved settings. Nothing is stored when
  nothing is flat or the plugin is stopped, and a failed save is tried again
  on the next start. A plugin that is off is never started, so until then
  `schema()` reads the stored options (`app.readPluginOptions()`) and gives
  each field whose setting is still flat that value as its default (and
  the AI help switch the value the move would give it): the form shows
  it, and a save stores it in its section rather than the default over
  it. A stored value the field does not take keeps the field's usual
  default, with a note in its description. Loading the form writes
  nothing, and a server without `readPluginOptions()`, or one that fails,
  gets the usual form.
- **Help from a model is an explicit opt-in.** Reading a rule the parser
  cannot uses the plugin's own Ollama settings, under **Rules in your own
  words**: a switch, off by default, and only while it is on the Ollama
  server address (`ollamaUrl`) and the model (`ruleAssistModel`, `qwen3:0.6b`
  when switched on). The form says that rules work without it and that
  Ollama is installed separately. The model is let go two minutes after use.
  `watchRuleAssist` and `watchHelperModel` are gone. Messages name the
  settings by their place in the form ("Rules in your own words → Ollama
  server address", "History server address").
- "Ask AI about this" and the other hand-offs to a model are now copy
  buttons: **Copy as text** on an incident and on the "most unusual" list,
  and **Copy for the log** on the report. They copy plain text, also over
  plain HTTP (where browsers offer no clipboard API), and show the text to
  copy by hand when the browser allows neither way.
- A rule-reading `ollamaUrl` that is not an http or https URL, has no scheme,
  or carries a user name, password, query or fragment is refused, and the
  compile answer says why; it is no longer quietly replaced by
  `http://localhost:11434`. A model that cannot be reached is named with its
  cause (`fetch failed: ECONNREFUSED`), without credentials the error quoted.
- Every History API request of a replay, the path listing included, waits
  `historyTimeoutMs` but at least 30 s; a setting of 0 no longer lets a
  listing that never answers keep the replay busy for good.
- Node.js 22.12 or later is required (`engines`), the oldest Node 22 the
  panel's build tooling (`@module-federation/vite`) accepts; Node 20 reached
  its end of life in April 2026. CI tests on Node 24 and 26.
- The plugin has its own icon, a lighthouse.
- The History API client keeps only what replay needs, with its own settings
  (`historyServerUrl`, `historyApiKey`, `historyProvider`,
  `historyTimeoutMs`) and environment variables
  (`SIGNALK_WATCHKEEPER_HISTORY_URL`, `SIGNALK_WATCHKEEPER_HISTORY_API_KEY`,
  `SIGNALK_WATCHKEEPER_HISTORY_TIMEOUT_MS`).
- A baseline learned under signalk-ai-bridge is not carried over: this plugin
  has its own data directory, so it learns afresh once. Stored watch rules
  can be copied over with `POST /watch/rules/save`.
