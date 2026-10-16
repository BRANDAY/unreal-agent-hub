# Profiles and detectors

This page explains profiles (`profiles/*.json`) and the detectors behind them (`lib/detect/*`): how a chat is matched to a profile, how heavy tool calls are gated, how the hub decides that a person is using a machine, and how to write your own profile. Related: [CONFIG.md](CONFIG.md), [ROLES.md](ROLES.md), [AGENTS.md](AGENTS.md).

## What a profile is

A profile describes one kind of project or workload in four parts:

| Part | Purpose |
|---|---|
| `match` | Which folders belong to it (marker files) |
| `busy` | How to tell that a person is using a machine for this workload (processes, GPU, load) |
| `gates` | Which tool calls and commands must wait for a shared resource |
| `holdTtlMin` | Lifetime of holds the gates take for the profile |

Profiles are plain JSON, loaded from the package folders `profiles/` and `profiles/examples/`. Machine config can override or add profiles (`profiles` key, shallow merge per profile name; see [CONFIG.md](CONFIG.md)).

## Fields

```json
{
  "name": "unreal",
  "description": "Unreal Engine projects ...",
  "match": { "markers": ["*.uproject"], "search": ["self", "parents", "children"] },
  "busy": {
    "processes": ["UnrealEditor", "ShaderCompileWorker", "*-Win64-Shipping"],
    "details": "unreal-editor",
    "gpu": "nvidia-smi",
    "graceMin": 3,
    "busyAbove": { "gpuMemPct": 85, "cpuPct": 90 }
  },
  "gates": [ { "tools": "^mcp__unreal-mcp__", "resource": "@machine" } ],
  "holdTtlMin": 60,
  "labels": { "en": { "busy": "Unreal is running" } }
}
```

| Field | Meaning |
|---|---|
| `match.markers` | File name globs (`*`, `?`, case-insensitive). The chat takes part when one is found |
| `match.search` | Where to look: `self` (the chat's folder), `parents` (all ancestors), `children` (direct sub-folders, hidden ones and `node_modules` skipped). Default: all three |
| `busy.processes` | Process name globs. On Windows `.exe` is optional. A match counts only if a person started it (see below) |
| `busy.details` | `"unreal-editor"` adds `project` and `since` to each Unreal editor process (from its command line). It is the only detail provider |
| `busy.gpu` | `"nvidia-smi"` (also the behaviour when the key is missing). `false` or `"none"` turns GPU reading off. Other GPU vendors report `null` |
| `busy.graceMin` | Minutes the machine stays "busy" after the person closes the profile's processes |
| `busy.busyAbove` | Load thresholds that make a machine busy even with no process: `gpuMemPct`, `gpuUtilPct`, `cpuPct`. Any one crossing is enough |
| `gates[]` | Gate rules, below |
| `holdTtlMin` | TTL for holds taken by the profile's gates and by node chats; falls back to `holdTtlMin` of the machine config |
| `labels` | Per-language texts. Data only: the current board does not read them |

## How a profile is picked

1. The profile named by `profile` in the project overlay, else `profile` in the machine config, is tried first (this is the only way to select a profile from `profiles/examples/`).
2. Then every non-example profile in file order (`generic.json`, then `unreal.json`): the first whose marker is found wins.
3. If nothing matches but the project has an overlay, `cfg.profile` or `generic` is used. If nothing matches and there is no overlay, the chat is left alone: the hook exits at once.

The `generic` profile matches on `.unreal-agent-hub.json`, so it is always tried last: in an Unreal project with an overlay, the `.uproject` marker wins and the Unreal gates apply together with the overlay's own `gates`. Writing `"profile": "unreal"` in the overlay makes the choice explicit.

## Gates

A gate rule says: when a tool call matches, wait for this resource.

| Field | Meaning |
|---|---|
| `tools` | Regular expression (case-sensitive) tested against the tool name, such as `^mcp__unreal-mcp__` |
| `commands` | Regular expression (case-insensitive) tested against the shell command. Only shell tools are checked (`Bash`, `PowerShell`, `Shell`, `shell`, `run_shell_command`) |
| `resource` | A resource name ([CONFIG.md](CONFIG.md#resource-names)); unresolved names are skipped |
| `mode` | `wait` or `hold`. Default: `hold` when the resource starts with `@` or `role:`, otherwise `wait` |
| `ttlMin` | Lifetime of a hold taken by this gate (`hold` mode only) |

- `wait`: the call waits, taking nothing, until the resource is free of other holders. The holder's own calls pass. Example: MCP calls to the Unreal editor wait while another chat restarts it.
- `hold`: the call takes the resource as a hold for this chat and keeps it until the chat's next `Stop` or `SessionEnd`, or its TTL. Example: a build command holds the machine.
- After `gateWaitSec` (default 1500) the call is denied with the holder's name and "Do other work and try again later". Any internal error lets the call through: the hub never blocks a chat for its own faults.
- Project gates (from the overlay) are added after the profile's gates; all matching gates are applied in order.
- On a node only gates for `@machine` or `@node:<this node>` are enforced, and they wait through the hub. Other gates are ignored there.

## The probe

`hub probe` prints what one machine is busy with. The hub runs it over the node's transport and caches the answer in `state/<node>.probe.json`.

```json
{
  "at": 1760631000000, "host": "laptop", "node": "laptop", "profile": "unreal",
  "busy": true, "reasons": ["processes"],
  "desktop": [ { "name": "UnrealEditor.exe", "pid": 4120, "memMB": 3120, "desktop": true, "since": 1760628000000, "project": "MyGame" } ],
  "remote":  [ { "name": "UnrealEditor-Cmd.exe", "pid": 5522, "memMB": 800, "desktop": false } ],
  "gpu": { "name": "NVIDIA GeForce RTX 3060", "usedMB": 1180, "totalMB": 12288, "util": 12, "apps": [ { "pid": 4120, "name": "UnrealEditor.exe" } ] },
  "cpuPct": 31, "load": { "busy": false, "why": [] }, "chats": 1
}
```

| Field | Meaning |
|---|---|
| `busy`, `reasons` | `processes` (a person's processes run) and/or `load` (a threshold crossed) |
| `desktop` | Matching processes started by a person; only these make the machine busy |
| `remote` | Matching processes started over ssh (the hub's own runs); never make it busy |
| `gpu` | Memory, utilisation and compute apps from `nvidia-smi`, or `null` |
| `cpuPct` | Measured over 500 ms, only when `busyAbove.cpuPct` is set |
| `load` | `busy` and `why[]` (for example `video memory 92% >= 85%`) |
| `chats` | Number of chats on that machine not marked ended |

The cached copy adds `fetched`, `by`, `online`, `error` and `lastBusyAt` (when processes last made it busy; the grace pause counts from there).

### Who counts as "a person": the session rule

- Windows: `tasklist` lists each process with a session number. Session 0 is the services session where OpenSSH runs commands; anything in a session other than 0 is a desktop session and counts as a person. A run started by the hub over ssh therefore never makes its own machine look busy.
- Linux and macOS: `ps -eo pid,sess,tty,rss,comm`. A process counts as a person's unless it shares a session with an `sshd` process. This is an approximation: services and cron jobs also count as desktop, and a process that detaches from the ssh session is misjudged.

## Built-in profiles

`profiles/generic.json`:

```json
{
  "name": "generic",
  "description": "No automatic gates: only explicit hub lock / hub hold / MCP holds. A chat takes part when its project has a .unreal-agent-hub.json.",
  "match": { "markers": [".unreal-agent-hub.json"], "search": ["self", "parents"] },
  "busy": { "processes": [], "gpu": false },
  "gates": [],
  "holdTtlMin": 60
}
```

`profiles/unreal.json`:

```json
{
  "name": "unreal",
  "description": "Unreal Engine projects: a chat takes part when a *.uproject is in its folder, a parent or a direct child folder.",
  "match": { "markers": ["*.uproject"], "search": ["self", "parents", "children"] },
  "busy": {
    "processes": ["UnrealEditor", "UnrealEditor-Cmd", "ShaderCompileWorker", "UnrealBuildTool",
      "*-Win64-Shipping", "*-Win64-Test", "*-Win64-Development", "*-Win64-DebugGame", "*-Linux-Shipping", "*-Mac-Shipping"],
    "details": "unreal-editor",
    "gpu": "nvidia-smi",
    "graceMin": 3,
    "busyAbove": { "gpuMemPct": 85, "cpuPct": 90 }
  },
  "gates": [
    { "tools": "^mcp__unreal-mcp__", "resource": "@machine" },
    { "commands": "UnrealEditor|UnrealBuildTool|RunUAT|Build\\.(bat|sh)|-(Win64|Linux|Mac)-(Shipping|Test|Development|DebugGame)", "resource": "@machine" }
  ],
  "holdTtlMin": 60,
  "labels": { "en": { "busy": "Unreal is running" }, "de": { "busy": "Unreal läuft" }, "fr": { "busy": "Unreal est ouvert" },
              "it": { "busy": "Unreal è aperto" }, "es": { "busy": "Unreal está abierto" }, "ru": { "busy": "открыт Unreal" } }
}
```

Both gates use `@machine`, so on a hub they only do something when `machineResource` is set ([CONFIG.md](CONFIG.md)), and on a node they hold the node's machine resource through the hub.

## Examples (not active unless named)

`profiles/examples/blender.json` gates Blender renders and the Blender MCP tools on the machine's GPU:

```json
{
  "name": "blender",
  "match": { "markers": ["*.blend"], "search": ["self", "parents", "children"] },
  "busy": { "processes": ["blender"], "gpu": "nvidia-smi", "graceMin": 2, "busyAbove": { "gpuMemPct": 85 } },
  "gates": [
    { "tools": "^mcp__blender__(execute_blender_code|generate_3d)$", "resource": "@machine" },
    { "commands": "blender(\\.exe)?\\s.*(-b|--background|--render|-f\\s)", "resource": "@machine" }
  ],
  "holdTtlMin": 60
}
```

`profiles/examples/docker-gpu.json` makes `docker run --gpus` and `docker compose up --gpus` wait for the machine:

```json
{
  "name": "docker-gpu",
  "match": { "markers": ["docker-compose.yml", "compose.yaml"], "search": ["self", "parents"] },
  "busy": { "processes": ["python", "python3"], "gpu": "nvidia-smi", "busyAbove": { "gpuMemPct": 80, "gpuUtilPct": 90 } },
  "gates": [ { "commands": "docker\\s+(run|compose\\s+up).*--gpus", "resource": "@machine" } ],
  "holdTtlMin": 120
}
```

To use one, set `"profile": "blender"` in the project overlay (or the machine config), or copy it to `profiles/` in a clone.

## Writing your own

1. Copy `profiles/examples/blender.json` and change `name`, `match.markers` and `busy.processes`.
2. Choose gates. Match the narrowest tool name or command that is really exclusive; broad patterns make every chat wait.
3. Keep `holdTtlMin` a little above your longest normal job.
4. Add the file to the machine config's `profiles` block, or name it in the overlay. Test the pattern with `hub probe` on the target machine and a harmless command.
