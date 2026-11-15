# Changelog

All notable changes to `signalk-watchkeeper` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/).

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
  already, so the redo had nothing left to write.
- Error text keeps the host that failed when a URL is followed by a quote,
  a bracket or a backslash and a later `@`, and an `@` after `//` inside a
  path is kept.
- The manual copy box selects its text again on the tap that follows focus
  (iOS).
- "Not above 95 °C", "not below 12 V" and "does not exceed" are read as
  their opposite (`atMost`, `atLeast`), in a rule and in its guard; "not
  above" was stored as `above`. A limit said with "should not", "must not",
  "may not" and the other modal forms keeps its comparison, like "never" and
  "shouldn't" ("should not exceed 14 V" is `above` 14, not `atMost`); "no
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
  the punctuation, or "..., tell me" after it - is refused: "alert me if the
  battery voltage should be below 12 V" may mean below 12 V or what is
  normal, and trivial rewordings ("alert me, if", "please, tell me if",
  "send me an alert if", "when ... should be below 12 V, tell me") no longer
  flip the rule between the two, nor do "should be at least", "should be no
  higher than" and "should not exceed" there give opposite rules. The
  refusal offers the two plain phrasings ('Say "alert me if battery voltage
  is below 12 V" or "battery voltage should stay above 12 V"'), quoting the
  condition without the "warn me" after it. "May", "can", "will" and the
  like as a modal without "not" (with a verb after it, or before "exceed"),
  a requirement with a verb of crossing ("should drop below 12 V", which may
  be the alert itself) and a requirement in a "while" are refused as
  ambiguous, with the same phrasings - in a "while", the condition said
  plainly ("while battery voltage is below 12 V"), as a "while" is no
  alert; such refusals, like a comparison negated twice, are not passed to
  the model, which is told that such requests say neither side. A "can"
  that is no modal ("jerry can below 20 %", "the jerry can is below 20 %",
  a path named "Jerry can") is part of the subject.
- An operating state (engine running, charger mode) is read from its path's
  primary source only: a second source reporting another value no longer
  flips it on every sample and keeps the paths it gates relearning.
- A sensor whose gaps grew before it went silent for good is still reported
  (after an hour's silence, or 1.5 times its longest gap): unconfirmed long
  gaps no longer end its watch. Its regular interval is updated by regular
  gaps only, so random gaps of 2 to 40 minutes no longer raise it until a
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
  feed, and no dropouts), and for five minutes at most. The feed alert
  comes up to one slow interval later (95 s rather than 30 s with a 55 s
  path that sent once after the rest stopped), and no longer opens and
  clears into the paths' dropouts a minute later, which split one event
  into two incidents; a finding that opens in the tick an incident resolved
  joins it again. Only the newest moments that enough paths share to be a
  feed are judged, so a vessel with thousands of paths that died one by one
  no longer costs seconds every tick. The group that went quiet most
  recently is the feed, not an older and larger one (whose connection may
  even be live, which left no feed at all): a group dead for an hour keeps
  its own dropouts and is left out of the count, so the gateway that dies
  now is reported, with its own sources; and a second connection going
  quiet joins a feed silence already reported. A connection is the label the server gives the source
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

- The plugin id is `signalk-watchkeeper`, and routes are under
  `/plugins/signalk-watchkeeper/watch/...`.
- Notifications are published under `notifications.watchkeeper.*` (they were
  under `notifications.aiBridge.watch.*`).
- Reading a rule the parser cannot uses the plugin's own Ollama settings:
  `ollamaUrl` and `ruleAssistModel` (blank is the parser only). The model is
  let go two minutes after use. `watchRuleAssist` and `watchHelperModel` are
  gone.
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
