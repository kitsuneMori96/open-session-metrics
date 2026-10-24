# @kitsunemori96/opencode-session-metrics

Deprecated: this package was renamed to
**[`@kitsunemori96/open-session-metrics`](https://www.npmjs.com/package/@kitsunemori96/open-session-metrics)**
when the project stopped being OpenCode-only.

This version is a bridge, not a copy: it depends on the renamed package and
forwards the `osm` command to it. An existing global install therefore keeps
working after `npm update -g`, with the same data directory, `OSM_*` variables
and command name.

Switch to the real package at your convenience:

```bash
npm uninstall -g @kitsunemori96/opencode-session-metrics
npm i -g @kitsunemori96/open-session-metrics
```

Uninstall first: both names provide the `osm` command, and removing the old
package afterwards can take the shared link with it. Your data directory,
`OSM_*` variables and history stay where they are.

Source and documentation: <https://github.com/kitsuneMori96/open-session-metrics>
