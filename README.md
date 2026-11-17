# Signal K Watchkeeper

A [Signal K](https://signalk.org) server plugin that watches every path of your
own vessel, learns how each one normally behaves, and raises a Signal K
notification when one departs from it.

It finds the things nobody set a threshold for: a coolant temperature creeping
up at cruise revs, an alternator that stopped charging, a sensor that froze or
dropped off the bus, a bilge pump cycling more often than it used to, a tank or
battery heading for its limit, a GNSS fix that dead reckoning and the other
receivers do not corroborate.

> Watchkeeper is experimental. It adds detection for things nobody set a
> threshold for. It does not replace the alarms already on the boat, and it is
> not a safety-critical system.

## How it works

- **Statistics, not a language model.** Every check is a small, deterministic
  computation on the CPU, microseconds per update. Every message is a template
  filled with the numbers the check measured.
- **Nothing to configure per boat.** It subscribes to every self-vessel path,
  standard or a plugin's own, and learns each one during a learning period
  (30 minutes by default). The learned baseline is saved, so a restart does not
  cost another learning period.
- **Operating states.** When an engine starts or a charger changes mode, the
  affected paths re-learn (or restore the baseline they had in that state)
  instead of alerting. Day and night are an operating state of everything
  solar, worked out from the vessel's own position. Other operating states
  are learned from the data: a path whose changes other paths reliably
  answer (a watermaker, a generator) becomes theirs, with no name needed.
- **Habits.** A path that keeps making the same kind of departure and coming
  back from it on its own (a radio link's packet loss spiking for a minute
  several times a day) is reported the first few times, then only when it
  goes further or lasts longer than its own episodes make likely, against an
  alert budget the sensitivity sets.
- **Its own yardsticks.** A sensor is stuck when it holds a value far longer
  than it ever normally does in that operating state; a counter shows itself
  by its resets and is watched by how fast it counts.
- **Incidents.** Related findings are grouped, earliest sign first.
- **Notifications** go under `notifications.watchkeeper.*`, at `warn` or
  `alert` only - never `alarm` or `emergency`, which belong to real alarm
  sources - so KIP, Freeboard, WilhelmSK and every other notification consumer
  shows them with no extra setup.
- **Your own watches.** Type a rule in plain words ("tell me if the coolant
  goes above 95 for 2 minutes", "warn me when the bilge pump runs while the
  engine is off"). A built-in parser reads it, with no model, and reads it back
  to you before anything is stored. Optionally a small Ollama model reads what
  the parser cannot.
- **Feedback and replay.** "Not useful" makes a path need a bigger departure
  next time. A replay runs a fresh watch over recorded history (the Signal K
  History API) and says what it would have raised, so sensitivity can be judged
  before it ever interrupts anyone.

The full reference - every check and its thresholds, the rule format, the HTTP
API and tuning - is in [docs/watchkeeper.md](docs/watchkeeper.md).

## Install

Watchkeeper needs a Signal K server running on Node.js 22.12 or later.

From the Signal K server's App Store, search for **Watchkeeper**, or:

```bash
cd ~/.signalk
npm install signalk-watchkeeper
```

Restart the server, open **Server → Plugin Config → Watchkeeper**, enable it
and switch on **Turn on Watchkeeper**. That is the only setting you need:
everything else has working defaults. The panel is under **Webapps →
Signal K Watchkeeper**.

Replay needs a History API provider plugin, such as signalk-to-influxdb2 or
signalk-parquet.

## Settings

The settings form starts with one switch, **Turn on Watchkeeper**, and groups
the rest into sections. In the plugin's options a setting is stored in its
section, for example `watching.watchSensitivity` (the keys are shown in
parentheses below). Settings saved by an earlier version are moved into the
sections on the first start, and shown in the form from the start even while
the plugin is off. The AI help is used only when its switch is on
and a model is named.

| Setting | Default | |
| --- | --- | --- |
| **Turn on Watchkeeper** (`watchEnabled`) | off | Start learning and watching |
| ***Alerts*** (`alerts`) | | |
| Send alerts as Signal K notifications (`watchNotifications`) | on | Under `notifications.watchkeeper.*`, at warn or alert, never alarm or emergency |
| Sound on serious alerts (`watchSound`) | off | Adds `sound` to alert-level notifications; warnings stay visual |
| ***What to watch*** (`watching`) | | |
| Sensitivity (`watchSensitivity`) | Normal | Calm – fewer alerts (`low`), Normal (`normal`), Sharp – more alerts (`high`) |
| Learning period (`watchLearningMinutes`) | 30 | Minutes before a new path can raise anything |
| Skip readings that move with the helm, wind and seabed (`watchDefaultExclusions`) | on | Heading, wind, depth and similar change quickly by nature |
| Also skip these paths (`watchExcludePaths`) | none | Paths or patterns |
| Counters under other names (`watchCounterPaths`) | none | Paths that only count up |
| ***Rules in your own words – optional AI help*** (`ruleAssist`) | | |
| Use a small AI model for wordings the built-in reader can't handle (`ruleAssistEnabled`) | off | Rules work without it; needs [Ollama](https://ollama.com), installed separately |
| Ollama server address (`ollamaUrl`) | `http://localhost:11434` | Shown once the switch is on |
| Model (`ruleAssistModel`) | `qwen3:0.6b` | Shown once the switch is on; unloaded two minutes after use |
| ***Replay from history – optional*** (`replay`) | | |
| History server address (`historyServerUrl`) | empty | Empty is this server |
| History API key (`historyApiKey`) | empty | For a history server that is not this one |
| History provider (`historyProvider`) | empty | A specific provider plugin |
| Wait per request, ms (`historyTimeoutMs`) | 30000 | Per replay request, at least 30 s |
| ***Advanced*** (`advanced`) | | |
| Most paths to watch (`watchMaxPaths`) | 1500 | A bound on memory and CPU |

The History API settings can also come from the environment:
`SIGNALK_WATCHKEEPER_HISTORY_URL` and `SIGNALK_WATCHKEEPER_HISTORY_API_KEY`
when those settings are blank, and `SIGNALK_WATCHKEEPER_HISTORY_TIMEOUT_MS`
only until the settings are first saved (the form then stores a timeout, its
default included). Which server is sent your session,
and how to make Signal K's own TLS certificate verify, are in
[Replay and the History API](docs/watchkeeper.md#replay-and-the-history-api).

Watch rules are stored with the plugin's settings, written by the panel.

## HTTP API

All routes are under `/plugins/signalk-watchkeeper`:

| Route | |
| --- | --- |
| `GET /watch/status` | What the watch has learned and found |
| `GET /watch/inventory` | Every path found, and what is done with each |
| `GET /watch/unusual` | The paths furthest from their own normal right now |
| `GET /watch/series?path=…` | The learned series behind a finding |
| `GET /watch/report?hours=24` | What the watch saw, as plain lines |
| `POST /watch/mute`, `POST /watch/unmute` | Silence a path for a while |
| `POST /watch/feedback` | "Not useful", or undo it |
| `POST /watch/rules/compile` | Read a plain-language rule back, without storing it |
| `POST /watch/rules/add`, `/remove`, `/save` | Change the stored rules |
| `POST /watch/replay` | Run a fresh watch over recorded history |

Routes that change something need a login with write access when Signal K
security is on. Details are in [docs/watchkeeper.md](docs/watchkeeper.md#http-api).

## Development

```bash
npm install
npm run check      # lint (smoke test), typecheck and tests
npm run build      # the embedded panel, into public/
```

To see the panel against the real backend code without a boat:

```bash
node scripts/preview-host.mjs --demo
```

```bash
SIGNALK_WATCHKEEPER_DEV_TARGET=http://127.0.0.1:3100 npm run dev
```

The demo pre-rolls 45 minutes of a normal passage, then the alternator stops
charging, the engine runs hot, a sensor drops off the bus and the GNSS fix
starts walking away from dead reckoning.

### CI and publishing

`signalk-plugin-ci` runs the
[Signal K reusable plugin CI](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml)
on every pushed branch and tag and on pull requests: package metadata, load
and lifecycle, an App Store install and the tests, on Linux, macOS and
Windows with Node 24 and 26, and in a live signalk-server. `ci` runs on pull
requests and `main`: lint, types, tests, a production audit, a Trivy scan of
the repository (failing on high or critical findings), and the suite again
from the packed tarball with production dependencies only.

The [Signal K plugin registry](https://signalk.org/signalk-plugin-registry/)
scores the published package, so a release:

- is published with `npm publish` from a git checkout of a commit that is
  pushed to GitHub (by convention, `main` after the release is merged), so
  npm records the commit (`gitHead`) the registry looks up a plugin-ci run
  for. GitHub starts a push run only for the newest commit of a push (not
  with `[skip ci]`), so publish from the tip of a push, or push a tag on the
  release commit, which starts a run there. A tarball, a tree without
  `.git`, or a commit never pushed costs 10 points;
- is the `latest` dist-tag: the registry tests that version and marks every
  other one outdated;
- keeps the tests in the tarball (`files` in `package.json`), since the
  registry runs `npm test` inside the installed plugin.

## History

Watchkeeper was first developed inside
[signalk-ai-bridge](https://github.com/KEGustafsson/signalk-ai-bridge) and moved
here as its own plugin: it needs no language model, and runs on any Signal K
server.

## License

European Union Public Licence v. 1.2 (EUPL-1.2). See [`LICENSE`](https://github.com/KEGustafsson/signalk-watchkeeper/blob/main/LICENSE).
