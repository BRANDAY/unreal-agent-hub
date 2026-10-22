# Configuration

This page covers every configuration key of Unreal Agent Hub, the three places it is read from, the names a resource can be called by, and the environment variables the hub understands. The source of truth is `lib/config.cjs`; for the bigger picture see [ARCHITECTURE.md](ARCHITECTURE.md).

## The three layers

| Layer | Where | What it holds |
|---|---|---|
| Machine | `~/.unreal-agent-hub/config.json` (`UAH_HOME` moves the whole folder) | Everything below: roles, resources, nodes, priorities, timing |
| Project overlay | `.unreal-agent-hub.json` in the project root, found by walking up from the chat's folder | `project`, `label`, `resources`, `gates`, `profile` only |
| Plugin options and environment | `CLAUDE_PLUGIN_OPTION_<KEY>` (Claude Code plugin settings) and `UAH_*` variables | `role`, node id, hub URL, token, port, language, gate wait |

How they combine in the code:

- Machine keys are merged over `DEFAULTS`. The objects `priorities`, `aging`, `handover`, `share`, `ssh`, `board` and `presence` are merged key by key; every other key (including lists) is replaced whole.
- Plugin options win over `UAH_*` variables, and both win over the machine file.
- The project overlay does not override machine keys. It adds a `project` block (its own resources, gates and profile) next to them.
- A missing machine file is fine: defaults apply, and `hub doctor` says so.

Inspect the result with `hub config` (tokens are shown as `***`). The state folder is always `<home>/state`.

## Machine file keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `role` | `"hub"` or `"node"` | `"hub"` | A hub keeps the queue and the board; a node forwards to a hub. See [ROLES.md](ROLES.md) |
| `id` | string | host name, lower case | Machine id. Reduced to letters, digits, `.`, `-`, `_` (64 characters at most) |
| `label` | string | `id` | Name shown on the board |
| `roles` | string[] | `["hub","build","workstation"]` | Machine roles of the hub itself: `hub`, `build`, `workstation`, `runner` |
| `port` | number | `8790` | Board port (always bound to `127.0.0.1`) |
| `lang` | string | `"en"` | Language of the hub: CLI output, hook messages, notifications, and the board's default. `en de fr it es ru`, any language with a `web/i18n/<lang>.json`, or `auto` (the system locale) |
| `name` | string | `"Unreal Agent Hub"` | Title of the board |
| `operator.at` | string | the hub's `id` | Machine id the person usually sits at; default target of `hub here` and `hub_here` |
| `machineResource` | string | none | Key of the hub's own machine resource. Needed for `@machine` on the hub and for presence on the hub |
| `resources` | object[] | `[]` | Machine-scope resources of the hub, see below |
| `nodes` | object[] | `[]` | Other machines, see below |
| `priorities` | object | `{presence:100, node-chat:50, hold:40, script:30, gate:30}` | Base queue priority per kind of taker |
| `aging` | object | `{everyMin:10, step:10}` | Waiting adds `step` points per `everyMin` minutes |
| `presenceTtlMin` | number | `180` | How long a presence mark lasts |
| `presence.blocks` | string[] | `["remote"]` | Reserved. The code does not read it; behaviour is fixed (see [ROLES.md](ROLES.md)) |
| `handover.ask` | boolean | `true` | A run blocked by a person also asks them |
| `handover.notify` | string[] | `["board"]` | Sinks: `board`, `remote-control` (see [TRANSPORTS.md](TRANSPORTS.md)) |
| `handover.askAgain` | boolean | `true` | Ask again after "not now" |
| `handover.askAgainMin` | number | `15` | Minutes before asking again |
| `handover.skipGraceWhenAsked` | boolean | `true` | A pending request ends the grace pause once Unreal is closed |
| `handover.restorePresence` | boolean | `true` | Put the person's presence mark back after a granted run |
| `share.prompt` | `none`, `clip160`, `full` | `"clip160"` | How much of a prompt is stored for the board: nothing, 160 characters, or up to 4000 |
| `ssh.path` | string | `"auto"` | ssh client; `auto` uses `C:\Windows\System32\OpenSSH\ssh.exe` on Windows when present, else `ssh` |
| `ssh.connectTimeoutSec` | number | `5` | `ConnectTimeout` passed to ssh |
| `gateWaitSec` | number | `1500` | How long a hook waits for a resource before denying the tool call |
| `defaultTtlMin` | number | `60` | TTL when neither the caller nor the resource gives one |
| `holdTtlMin` | number | `60` | TTL of holds that have no better value (profile `holdTtlMin` comes first) |
| `waitMin` | number | `240` | How long `hub lock`, `take` and `hold` wait before giving up |
| `board.allowHosts` | string[] | `[]` | Extra `Host` header values the board accepts, see [BOARD.md](BOARD.md) |
| `profile` | string | `""` | Force a profile name for every project on this machine |
| `profiles` | object | none | Per-profile overrides, see below |

Node-side keys (in the config of a machine with `role: "node"`):

| Key | Meaning |
|---|---|
| `hubUrl` | Where the hub is reachable, for example `http://127.0.0.1:18791` through the reverse tunnel |
| `token` | The token `hub node add <id>` printed. Plugin option `token` and `UAH_NODE_TOKEN` also set it |
| `transport`, `folder` | With `transport: "folder"` and `folder` set, the node also writes its probe and chats to that folder |
| `tlsInsecure` | `true` turns off TLS certificate checks for an `https` hub URL. Not recommended; see [SECURITY.md](SECURITY.md) |
| `nodeResource` | Key that `@machine` means on this node (default: the node's `id`) |

### `resources[]`

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Name used in commands |
| `scope` | `machine` (machine file), `project` (overlay) | Where the resource lives |
| `ttlMin` | `60` | Hold or lock lifetime if the caller gives none |
| `label` | `id` | Board name |
| `icon` | `""` | Board icon: `cpp cook machine smoke editor gpu box`; unknown names fall back to the resource id, then to a box |
| `color` | by icon | Board colour: a Mantine colour name (`blue`, `orange`, `violet`, `pink`, `teal`, `grape`, `lime`, `cyan`, `yellow`, `indigo`, `red`, `green`, `gray`) or any CSS colour |

The internal key is `id` for machine resources and `<project>~<id>` for project resources.

### `nodes[]`

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Node id (sanitised like `id`) |
| `label`, `detail` | `id`, none | Board name and a second line (for example the GPU) |
| `roles` | `["runner"]` | `runner`, `workstation`, `build`, ... |
| `transport` | `"ssh-reverse"` | `ssh-reverse`, `http`, `folder`; see [TRANSPORTS.md](TRANSPORTS.md) |
| `ssh` | node `id` | ssh alias used to reach the node |
| `tunnelPort` | none | Port on the node that the hub's `ssh -R` tunnel opens back to the board |
| `hubPath` | `.unreal-agent-hub/bin/hub.cjs` | Path of `hub.cjs` relative to the node user's home |
| `folder` | none | Synced folder for the `folder` transport |
| `token` | none | Shared secret. Without one, any local process on the node can speak for it |
| `profile` | `"unreal"` | Profile used to judge whether a person is busy on that machine |
| `resources` | one resource named like the node | Machine resources of the node; each defaults to `ttlMin: 180`, the node's label, icon `machine` |

### `profiles` overrides

`profiles.<name>` is merged over the profile file with a shallow copy, so giving `busy` replaces the whole `busy` block:

```json
{ "profiles": { "unreal": { "busy": { "processes": ["UnrealEditor"], "graceMin": 5 } } } }
```

Profile contents are described in [PROFILES.md](PROFILES.md).

## Project overlay `.unreal-agent-hub.json`

| Key | Meaning |
|---|---|
| `project` | Project name; default is the folder name. Used as the prefix of resource keys |
| `label` | Board group name (default `project`) |
| `resources` | Project-scope resources (same fields as above; `scope` defaults to `project`) |
| `gates` | Extra gate rules added to the profile's gates ([PROFILES.md](PROFILES.md)) |
| `profile` | Force a profile for this project |
| `watch` | The project app watch on top of the profile's: `start` command, port, log; `false` turns it off ([WATCH.md](WATCH.md)) |
| `files` | File gate settings on top of the profile's, single keys replaced; `false` turns the gate off ([FILES.md](FILES.md)) |

A `labels` key is read into the configuration but nothing uses it yet. The hub remembers every overlay it has seen in `state/projects/<id>.json`, so the board lists a project's resources even before anyone takes one.

## Resource names

`resolve()` turns what you type into resources:

| Name | Meaning |
|---|---|
| `cpp` | Machine resource with that id; inside a project, a project resource with that id wins |
| `MyGame~editor` | Project resource by its full key |
| `@machine` | This machine's own machine resource (a node: `nodeResource` or its id; the hub: `machineResource`) |
| `@node:laptop` | The first machine resource of node `laptop` |
| `role:runner` | Pool of every machine resource whose machine has that role; the first free member is taken |

Unknown names fail (`hub lock` exits 75). On the hub, resources of the hub itself join a `role:` pool only if they carry `"kind": "machine"`; node resources always do.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `UAH_HOME` | everything | Folder replacing `~/.unreal-agent-hub` (config, state, shim) |
| `UAH_PORT` | board | Overrides `port` |
| `UAH_LANG` | all | Overrides `lang` |
| `UAH_ROLE` | config | Overrides `role` (`CLAUDE_PLUGIN_OPTION_ROLE` wins) |
| `UAH_NODE_ID` | config | Overrides `id` (`CLAUDE_PLUGIN_OPTION_NODE_ID` wins) |
| `UAH_HUB_URL` | node | Overrides `hubUrl` (`CLAUDE_PLUGIN_OPTION_HUB_URL` wins) |
| `UAH_NODE_TOKEN` | node | Overrides `token` (`CLAUDE_PLUGIN_OPTION_TOKEN` wins) |
| `UAH_GATE_WAIT_SEC` | hooks | Overrides `gateWaitSec` |
| `UAH_CHAT` | lock client | Chat name shown on the board for locks taken from this process |
| `UAH_SESSION` | lock client | Session id; `CLAUDE_CODE_SESSION_ID` is used when it is not set |
| `UAH_TOKEN_<KEY>` | lock client | Set by `hub lock` and the PowerShell module so nested calls pass through (`cpp` gives `UAH_TOKEN_CPP`, `MyGame~cook` gives `UAH_TOKEN_MYGAME_COOK`) |
| `UAH_NODE_PROBE=off` | lock client | Never ask a node whether a person is busy (queue ignores probes) |
| `UAH_HUB_CJS` | PowerShell module | Full path of `hub.cjs` to use; see [POWERSHELL.md](POWERSHELL.md) |

The Claude Code plugin declares four options (`role`, `node_id`, `hub_url`, `token`); empty values are ignored. The plugin's default for `role` is `hub`, so on a node set the plugin option to `node` explicitly. Whether Claude Code exports unset defaults as `CLAUDE_PLUGIN_OPTION_*` is unverified here.

## Examples

`examples/config.hub.json` (hub with one node):

```json
{
  "role": "hub", "id": "studio", "label": "Studio PC",
  "roles": ["hub", "build", "workstation"], "port": 8790, "lang": "en",
  "operator": { "at": "studio" },
  "resources": [ { "id": "cpp", "scope": "machine", "ttlMin": 90, "label": "C++ build", "icon": "cpp" } ],
  "nodes": [ {
      "id": "laptop", "label": "Laptop", "detail": "RTX 3060, 12 GB", "roles": ["runner", "workstation"],
      "transport": "ssh-reverse", "ssh": "laptop", "tunnelPort": 18791, "profile": "unreal",
      "resources": [{ "id": "laptop", "ttlMin": 180 }],
      "token": "generated by: hub node add laptop"
  } ],
  "priorities": { "presence": 100, "node-chat": 50, "hold": 40, "script": 30, "gate": 30 },
  "aging": { "everyMin": 10, "step": 10 },
  "presenceTtlMin": 180,
  "handover": { "ask": true, "notify": ["board"], "askAgainMin": 15, "skipGraceWhenAsked": true, "restorePresence": true },
  "share": { "prompt": "clip160" }, "gateWaitSec": 1500, "ssh": { "path": "auto" }
}
```

The example sets `"machineResource": "studio"` with a resource `{ "id": "studio" }`, so `hub here` and `@machine` act on the hub itself too. Leave both out if the hub's own desktop should not take part.

`examples/config.node.json` (on the laptop):

```json
{
  "role": "node", "id": "laptop",
  "hubUrl": "http://127.0.0.1:18791",
  "token": "the token printed by `hub node add laptop` on the hub",
  "profile": "unreal", "share": { "prompt": "clip160" }, "gateWaitSec": 1500
}
```

`examples/.unreal-agent-hub.json` (project root):

```json
{
  "project": "MyGame",
  "resources": [
    { "id": "cook",  "scope": "project", "ttlMin": 180, "label": "Cook / Packaged", "icon": "cook" },
    { "id": "smoke", "scope": "project", "ttlMin": 90,  "label": "Smoke tests",     "icon": "smoke" },
    { "id": "editor","scope": "project", "ttlMin": 30,  "label": "Editor restart",  "icon": "editor" }
  ],
  "gates": [
    { "tools": "^mcp__unreal-mcp__", "resource": "editor", "mode": "wait" },
    { "commands": "\\\\Packaged\\\\|remote_run\\.ps1|run_smoke", "resource": "@node:laptop" }
  ]
}
```
