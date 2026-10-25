# Command line

This page documents every command of the `hub` command line (`bin/hub.cjs`, also installed as `unreal-agent-hub`): what it does, its options, and its exit codes. Run `hub help` for the short version. The MCP equivalents are in [MCP.md](MCP.md); scripts on Windows can use [POWERSHELL.md](POWERSHELL.md).

## Resource names

Commands that take `<res>` accept an id (`cpp`), a project resource (`editor`, when the current folder has a `.unreal-agent-hub.json`), a full key (`MyGame~editor`), `@machine`, `@node:<id>` or a pool `role:runner`. Details: [CONFIG.md](CONFIG.md#resource-names).

## Commands

| Command | What it does |
|---|---|
| `hub status [--json]` | Every resource with its holder, queue (in serving order, with effective priority) and handover requests |
| `hub lock <res>[,<res>...] [opts] -- <command...>` | Wait for `<res>`, run the command while holding it, release when it ends (like `flock`). Several resources are taken in the order given |
| `hub hold <res> [opts]` | Hold `<res>` for this chat until `hub release`, the end of the chat's agent process, or the TTL |
| `hub release <res> [--force]` | Release a hold of this chat. `--force` releases anyone's; ask the owner first |
| `hub break <res> [--force]` | Drop a stale lock. `--force` also drops a live one |
| `hub here [<machine>] [--off] [--ttl N]` | Presence: "I am sitting at this machine" |
| `hub claims [--json]` | Files claimed by chats through the file gate, held or over ([FILES.md](FILES.md)) |
| `hub claims release <path>` | Free one claim by hand; ask its holder first |
| `hub watch [status\|down\|up] [--note T]` | The project app (editor): its state; `down` = closed by a chat, it comes back; `up` = it is back ([WATCH.md](WATCH.md)) |
| `hub stamp <name> [--files a,b] [--note T]` | Record who made `<name>` (a build): this chat, the time, the commit and the files' time and size (below) |
| `hub whose <name> [--require] [--json]` | Is `<name>` this chat's own? One line; `--require` exits `3` when it is not |
| `hub grant [<res or machine>] [--token T]` | Answer a handover request: yes, take it |
| `hub decline [<res or machine>] [--token T]` | Answer a handover request: not now |
| `hub serve [--port N] [--no-tunnels]` | Run the board ([BOARD.md](BOARD.md)) |
| `hub probe` | Print what this machine is busy with, as JSON ([PROFILES.md](PROFILES.md)) |
| `hub dump` | Print this machine's chats as JSON |
| `hub hook [--agent claude\|codex\|cursor]` | Hook entry point; reads the agent's JSON on stdin ([AGENTS.md](AGENTS.md)) |
| `hub mcp` | MCP server over stdio ([MCP.md](MCP.md)) |
| `hub install-hooks --agent A [--uninstall] [--dry-run] [--file F]` | Write or remove the hub's hooks in an agent's settings file |
| `hub node add <id> [...]` | Add a node to the machine config and print the config for the node |
| `hub node install <id>` | Print the steps to set a node up (nothing is run) |
| `hub duty` | Make this chat the hub's duty chat for notifications |
| `hub take <res> --pid N [opts]` | Take a resource for an existing process; for script wrappers |
| `hub free <res> --token T` | Release what `take` took |
| `hub config [--json]` | Print the merged configuration (tokens hidden, profiles omitted) |
| `hub doctor` | Check the setup |
| `hub version` | Print the version |

`hub status --json` prints an array; each row has `key`, `label`, `scope`, `node`, `holder`, `queue`, `asks` and `machine`, and for places `slots`, `hold` and `holders` (one record per place). `hub config` always prints JSON.

## Options for `lock`, `hold` and `take`

| Option | Meaning |
|---|---|
| `--ttl N` | Lifetime in minutes (default: the resource's `ttlMin`, then `defaultTtlMin`) |
| `--note TEXT` | Shown on the board |
| `--no-wait` | Fail at once if the resource is busy |
| `--wait-min N` | Give up after N minutes (default `waitMin`, 240) |
| `--priority N` | Override the base priority of this waiter ([ROLES.md](ROLES.md)) |
| `--ask` / `--no-ask` | Force or forbid a handover request when a person is in the way (default: `handover.ask`) |
| `--chat NAME` | Chat name shown on the board |
| `--shared` | Take one place of a resource with `slots` > 1; without it a take holds every place ([CONFIG.md](CONFIG.md#resources)) |

While waiting, a line is printed to stderr every minute: `[hub] <key> is busy: <holder>. Waiting...`. When the resource is taken after more than six seconds, `[hub] took <key> after N min.` is printed.

## `hub lock`

```bash
hub lock cpp --note "Editor target" -- ./build.sh MyGameEditor
hub lock role:runner --ttl 120 -- node run-smoke.js
hub lock cook --no-wait -- python package.py     # exit 75 at once if busy
hub lock cpp,cook --ttl 180 -- RunUAT.bat BuildCookRun -project=MyGame.uproject -cook -build -stage -pak
```

- `cpp,cook` takes `cpp`, then `cook`, and releases them in reverse when the command ends. If one cannot be taken (`--no-wait`, `--wait-min`), the ones already taken are released and the exit code is 75. Keep one order everywhere (`cpp` before `cook`): a packaging run holds the build for its whole length because the cook loads the editor's modules ([FILES.md](FILES.md#packaging-holds-the-build-and-the-cook)).

- Everything after `--` is the command. The hub puts the token into the child's environment as `UAH_TOKEN_<KEY>`, so a nested `hub lock` of the same resource passes through instead of waiting for itself.
- The lock belongs to the `hub lock` process. If it dies, the lock is stale and the next taker removes it.
- On Windows the command goes through `cmd.exe` as one quoted string, so `.cmd`, `.bat` files and built-ins work. On other systems it is started directly.
- `SIGINT` and `SIGTERM` are forwarded to the child. The exit code of `hub lock` is the child's exit code (1 if the child was killed by a signal).

## `hub hold` and `hub release`

A hold outlives the command, so it needs an owner. Run it from an agent chat (the hub reads the agent's session and process id from the environment), or pass both `--chat NAME` and `--ttl N`. Without either, the command refuses.

```bash
hub hold editor --note "rebuild cycle"
# ... several steps ...
hub release editor
```

A resource with `hold: false` refuses holds (exit 75): it is taken only for the run itself, by `hub lock` or `hub take`.

Holds taken by hooks end at `Stop` and `SessionEnd`; holds taken with `hub hold` or `hub_hold` do not end at the end of a turn, only at release, owner exit, or TTL.

## `hub break`

A stale lock (TTL over, or its process gone) is removed without `--force`. On a resource with places, `--force` drops every place; `--place N` only that one. A live lock needs `--force`; the command prints that nothing here stops processes. Do not force-break another chat's lock without asking its owner.

## `hub here`

```bash
hub here laptop            # I sit at the laptop: remote runs queue and ask
hub here laptop --off
hub here --ttl 90
```

Without a machine the target is `operator.at`, then the hub's own `id`. The machine needs a machine resource (a node's resource, or the hub's `machineResource`), otherwise the command says so. Default TTL is `presenceTtlMin`.

## `hub take` and `hub free`

For wrappers that own a process (the PowerShell module uses them):

```bash
hub take cpp --pid 4242 --script build.ps1 --note "Win64 Development"
# {"ok":true,"key":"cpp","token":"a1b2c3d4e5f6","reentrant":false,"presence":false,"ttlMin":90,"waitedMs":0}
hub free cpp --token a1b2c3d4e5f6
```

`take` prints one JSON object. The lock is tied to `--pid`; when that process exits, the lock is stale.

## `hub node`

```bash
hub node add laptop --ssh laptop --tunnel-port 18791 --label "Laptop" --roles runner,workstation
hub node install laptop
```

`add` writes the node into `~/.unreal-agent-hub/config.json` (a random 64-hex-character token is generated if the node has none) and prints the config to place on the node. It never touches ssh keys. Defaults: `--ssh` is the node id, `--roles` is `runner,workstation`, the tunnel port is `18791` plus the node's index.

## `hub install-hooks`

```bash
hub install-hooks --agent claude --dry-run
hub install-hooks --agent codex
hub install-hooks --agent cursor --uninstall
```

`--file F` writes to another settings file; `--dry-run` prints the result instead of writing. Exact files and contents: [AGENTS.md](AGENTS.md).

## `hub doctor`

Prints `ok`, `warn` or `info` lines: Node.js version, machine config, state folder, role and id, whether the board port answers, each node's token, the ssh client, the shim `~/.unreal-agent-hub/bin/hub.cjs`, and where each agent's hooks are installed.

## `hub stamp` and `hub whose`

A lock says who goes now, not what the previous holder left behind. A chat that runs its required checks right after
another chat's experimental build tests that build, and learns it only from the results. So the step that makes
something others will use stamps it, and the step that uses it asks whose it is:

```bash
# end of the build script, after a successful build
hub stamp build --files "Binaries/Win64/UnrealEditor-MyGame*.dll" --note "Development"
# start of a smoke test
hub whose build              # "build" is from chat A, 14:02, not yours · commit 1a2b3c4 · 3 uncommitted files
hub whose build --require    # the same text on stderr and exit code 3: for required checks
```

- A stamp lives in `state/stamps/<project>~<name>.json` inside a project with an overlay (else `<name>.json`): chat,
  session, machine, time, `git` commit and the number of uncommitted files, and the time and size of every file of
  `--files`. A wildcard is allowed in the file name only (`Binaries/Win64/UnrealEditor-*.dll`).
- "Mine" means the same agent session (`CLAUDE_CODE_SESSION_ID` / `UAH_SESSION`). Files that changed since the stamp
  make it "unknown": they were made outside the stamping step.
- The `calls` of a gate stamp what they open (`load_level` stamps `level` with the level path) and tell the model
  before an app-wide call when a stamp in `notes` is another chat's ([PROFILES.md](PROFILES.md#app-wide-calls)).
- PowerShell: `Set-HubStamp` and `Assert-HubOwn` ([POWERSHELL.md](POWERSHELL.md)).

## Exit codes

| Code | When |
|---|---|
| `0` | Success. Also `hub hook` always, and `hub serve` when the port is already taken (the board is already running) |
| `1` | Usage errors, refused actions (`hub release` of someone else's lock without `--force`, `hub break` of a live lock without `--force`), `hub grant`/`decline` with no matching request, a `hub lock` child killed by a signal |
| `3` | `hub whose --require`: the stamp is another chat's, unknown or missing |
| `75` | The resource could not be taken: busy with `--no-wait`, wait timed out, aborted, or an unknown resource name. Used by `lock`, `take` and `hold` |
| `127` | `hub lock` could not start the command (spawn error). On Windows the command runs through `cmd.exe`, so a missing program is reported by `cmd.exe` with its own code (not verified here) |
| other | `hub lock` returns the child's exit code unchanged |

A script can treat 75 as "busy, try later":

```bash
hub lock cook --no-wait -- ./package.sh
if [ $? -eq 75 ]; then echo "cook is busy, doing something else"; fi
```
