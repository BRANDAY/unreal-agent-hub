# Watch: the editor restarts without breaking the other chats

For Unreal, the MCP server the agents talk to is the editor itself. When one chat restarts it (close, build, start
again), every other chat's MCP call in that window hits a dead port and fails, and an editor that a chat closed (or
that crashed) stays down until somebody notices. The watch closes both gaps. It is configured by a `watch` block in
the profile and in the project overlay, and has three parts.

## 1. Markers: "closed by a chat, it comes back"

Your scripts say what they do:

```powershell
# close_editor.ps1, before closing it for a rebuild
hub watch down --note "rebuild"
# editor.ps1, after the MCP port answers again
hub watch up
```

`hub watch down` leaves `state/watch/<project>.down.json` (who, when). A script that closes the editor to leave it
closed does not call it. The watchdog removes the marker by itself as soon as the port answers, so a forgotten
`hub watch up` costs nothing.

## 2. The gate: calls wait for the restart

An agent tool call that needs the app (`watch.tools`, `^mcp__unreal-mcp__` in the unreal profile) waits in the
`PreToolUse` hook while the port is dead **and** a restart is under way:

- one of the `busy` resources is held (`cpp`, `cook`, the project's `editor`: a build or a restart cycle);
- the `down` marker is up (a chat closed it);
- the board's watchdog started it less than `openingMin` (20) minutes ago.

When the port answers, the call goes on. Down with none of these (a person closed the editor) the call goes on at
once and fails as it always did. After `gateWaitSec` (25 min) the call is denied with the reason; the board shows the
chat as waiting for `restart`.

## 3. The watchdog: open it again

The board (`hub serve`) checks every 30 s each project the hooks have seen with a `watch.start` command. It starts
the app when all of these hold:

- the port is dead and no app process (`watch.processes`) is running - a booting or hung editor is not touched;
- no `busy` resource has been held for `quietMin` (2) minutes - never in the middle of a build or a cook;
- a chat closed it (the `down` marker), **or** the app's log (`watch.log`) does not end with a clean exit
  (`watch.cleanExit`): a crash or a kill. One start per crash: if the log has not changed since the last start, it
  waits for a person.

A clean exit with no marker is a person's own close: it stays closed. At most `maxPerHour` (2) starts an hour. Each
decision is written to `state/log.txt` as a `WATCH` line, once per change. `UAH_WATCH=0` turns the watchdogs off.

## Configuration

The unreal profile ships the detection; the project adds the command that starts its editor:

```json
"watch": {
  "port": 8000,
  "tools": "^mcp__unreal-mcp__",
  "processes": ["UnrealEditor"],
  "log": "Saved/Logs/{marker}.log",
  "cleanExit": "Log file closed|LogExit: Exiting",
  "busy": ["cpp", "cook", "editor"]
}
```

```json
{
  "project": "MyGame",
  "resources": [ { "id": "editor", "ttlMin": 30 } ],
  "watch": { "start": ["powershell", "-NoProfile", "-File", "Tools/editor.ps1"] }
}
```

| Key | Default | Meaning |
|---|---|---|
| `port` | none | The app's port on 127.0.0.1. Without it the watch is off |
| `tools` | `""` | Agent tool names (regex) that wait during a restart |
| `processes` | `[]` | App process name globs; a running one means "booting or hung": the watchdog keeps its hands off |
| `start` | none | Command (argv list), run in the project root, detached. Without it the watchdog only reports |
| `log` | `""` | The app's log, relative to the project root; `{marker}` is the profile marker's name (`MyGame.uproject` -> `MyGame`) |
| `cleanExit` | `""` | Regex that the last 8 KB of the log contains after a clean exit |
| `busy` | `[]` | Resource names whose holders mean "a build or a restart is under way" |
| `quietMin` | `2` | Minutes after the last `busy` lock before the watchdog acts |
| `maxPerHour` | `2` | Starts an hour at most |
| `openingMin` | `20` | How long after a watchdog start agent calls still wait for it |

In the overlay, single keys replace the profile's; `"watch": false` turns it off for the project.

```bash
hub watch            # MyGame: port 8000 is dead, restart under way: closed by Fix the cook crash at 14:02, coming back
hub watch down --note rebuild
hub watch up
```

## Limits

- The agent's own MCP client gives up on a server that was gone for a while: after a restart longer than its retry
  window (about 31 s in Claude Code), a chat that talks to the editor directly has to reconnect (`/mcp`). Put the
  hub's MCP proxy in between (`hub mcp-proxy install --agent claude`, [MCP-PROXY.md](MCP-PROXY.md)): the chat stays
  connected, calls wait in the proxy and pass when the editor is back. A proxied call is not held by this gate as well.
- The watchdog runs on the board's machine (the hub), for projects on that machine.
- It never stops a process. A hung editor (process alive, port dead) is left for a person.
