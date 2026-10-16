# Agents: Claude Code, Codex and Cursor

This page explains how Unreal Agent Hub talks to the three supported coding agents: the hook events and payloads of each (`lib/agents/*.cjs`), the answers the hub prints, how an agent is detected, how hooks are installed (`lib/install-hooks.cjs` or a plugin), and what is verified and what is not. The hook logic itself is in `lib/hook.cjs`; resources and gates are in [PROFILES.md](PROFILES.md); the system overview is [ARCHITECTURE.md](ARCHITECTURE.md).

## One hook command for everything

Every agent runs the same command on its events: `hub hook [--agent claude|codex|cursor]`. It reads the agent's JSON from stdin, converts it into a common event, does the work, and prints the answer in the format the agent expects. Chats outside every profile (no `*.uproject` or overlay nearby) are left alone at once, and any internal error fails open: the command exits 0, and the error goes to `state/hook-errors.log`.

## Event mapping

| Hub event | Claude Code | Codex | Cursor |
|---|---|---|---|
| `SessionStart` | `SessionStart` | `SessionStart` | `sessionStart` |
| `UserPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit` | `beforeSubmitPrompt` |
| `PreToolUse` | `PreToolUse` | `PreToolUse` | `beforeShellExecution`, `beforeMCPExecution`, `preToolUse` |
| `Notification` | `Notification` | not available | not available |
| `Stop` | `Stop` | `Stop` | `stop` |
| `SessionEnd` | `SessionEnd` | `SessionEnd` | `sessionEnd` |

What each event does: `SessionStart` and `UserPromptSubmit` record the chat for the board and may add one or two lines of context; `PreToolUse` applies the gates (heavy work waits, or is denied after `gateWaitSec`); `Notification` marks a chat that needs a person; `Stop` and `SessionEnd` mark the chat idle or ended and release holds the hooks took.

Without `Notification` (Codex, Cursor) the board cannot show "needs you" from a permission prompt; it only sees working and idle.

## Payload fields

| Common field | Claude Code and Codex | Cursor |
|---|---|---|
| session | `session_id` (or `CLAUDE_CODE_SESSION_ID`, Codex: `CODEX_SESSION_ID`) | `conversation_id`, else `session_id` |
| folder | `cwd` (or `CLAUDE_PROJECT_DIR`) | `cwd`, else the first of `workspace_roots` |
| tool | `tool_name` | `Shell` for `beforeShellExecution`; `mcp__<mcp_server_name>__<tool_name>` for `beforeMCPExecution` (so the same gates match); `tool_name` for `preToolUse` |
| command | `tool_input.command` | `command` (shell hook) or `tool_input.command` (`preToolUse`, a JSON object or a string holding JSON) |
| prompt | `prompt` | `prompt` |
| title | `session_title` | none |
| notification | `notification_type`, `message` | none |
| last reply | `last_assistant_message` | none |

Notification types: `permission_prompt`, `elicitation_dialog` and `agent_needs_input` set the chat to "needs you"; `idle_prompt` sets it to idle.

## What the hub prints

| Answer | Claude Code and Codex | Cursor |
|---|---|---|
| Allow | nothing (empty output) | `{"continue":true,"permission":"allow"}` for permission events; `{"continue":true}` for `beforeSubmitPrompt`; nothing for the others |
| Deny | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` | `{"continue":true,"permission":"deny","user_message":"...","agent_message":"..."}` |
| Context for the model | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`, only for `SessionStart` and `UserPromptSubmit` | `{"additional_context":"..."}` on `sessionStart` only |

Cursor needs care: permission hooks must print valid JSON even when they allow, because invalid JSON blocks the action. A crash or timeout of the hook command lets the action through (fail open), according to the comments in `lib/agents/cursor.cjs`; this follows Cursor's documentation as understood by the authors and is not verified on a live install. If `hub hook` itself throws, it prints nothing and exits 0.

## Detecting the agent

Two separate questions:

- Input agent (who sent the payload, used to label the chat). In order: Cursor if the payload has `cursor_version`, `conversation_id` or `workspace_roots`; Codex if it has `turn_id`, or if `PLUGIN_ROOT` is set while `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` are not; otherwise Claude Code.
- Output format (how to answer). The agent named by `--agent`, if given; otherwise the input agent.

They differ in one real case: Cursor can read hooks from `~/.claude/settings.json` (its Third-Party Imports feature). Cursor then sends its own payload but expects Claude's answer, which it translates itself. The hooks written by `install-hooks --agent claude` carry `--agent claude`, so the chat is labelled Cursor and the answer is in Claude's format. Plugin hooks carry no `--agent`.

## Who owns a hold

| Agent | Owner process id | A hold ends when |
|---|---|---|
| Claude Code | `CLAUDE_PID` from the environment | the process exits, `Stop`/`SessionEnd` (hook holds), release, or TTL |
| Codex | none | `Stop`/`SessionEnd` (hook holds), release, or TTL |
| Cursor | none | `Stop`/`SessionEnd` (hook holds), release, or TTL |

Holds taken explicitly (`hub hold`, `hub_hold`) are not released at `Stop`. For agents without an owner process id they last until released or until their TTL, so give them one (`--ttl`). MCP holds use the server's parent process; see [MCP.md](MCP.md).

## Installing hooks

Two ways: a plugin (Claude Code) or `hub install-hooks`.

```bash
hub install-hooks --agent claude [--dry-run] [--uninstall] [--file path]
```

It writes the hub's entries into the agent's user settings, marks them by their command, so running it again replaces them and `--uninstall` removes exactly them (foreign hooks stay). The previous file is kept next to it as `<file>.bak-agent-hub-<time>`. It also writes the shim `~/.unreal-agent-hub/bin/hub.cjs`, a fixed path that forwards to the installed version. Every entry runs `node "<home>/bin/hub.cjs" hook --agent <agent>`.

| Agent | File written | Entries |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `SessionStart` (10 s), `UserPromptSubmit` (10 s), `PreToolUse` matcher `Bash\|PowerShell\|mcp__.*` (1800 s, status message "waiting for a shared resource"), `Notification` (10 s, async), `Stop` (10 s, async), `SessionEnd` (10 s) |
| Codex | `~/.codex/hooks.json` | `SessionStart`, `UserPromptSubmit` (10 s each), `PreToolUse` matcher `^(Bash\|shell\|mcp__.*)$` (1800 s), `Stop` (10 s), `SessionEnd` (3 s) |
| Cursor | `~/.cursor/hooks.json` (`{"version":1,"hooks":{...}}`) | `sessionStart`, `beforeSubmitPrompt`, `stop`, `sessionEnd` (10 s each), `beforeShellExecution`, `beforeMCPExecution` (1800 s) |

Notes per agent:

- Codex runs new hooks only after you trust them: open Codex and run `/hooks`. The command also prints the `[mcp_servers.unreal-agent-hub]` block for `~/.codex/config.toml`.
- Cursor already reads `~/.claude/settings.json`. Install into `~/.cursor/hooks.json` only on a machine without the Claude Code hooks, otherwise the hooks run twice; the command warns if it finds the hub in the Claude file.
- `install-hooks` installs hooks only. The MCP server is registered separately ([MCP.md](MCP.md)).
- The Codex matcher uses the tool names `Bash` and `shell`; these names come from the authors' reading of Codex's hook documentation and are unverified on a live install.

## Plugin manifests

| File | For | Contents |
|---|---|---|
| `.claude-plugin/plugin.json` | Claude Code | Name, version, `userConfig` (`role`, `node_id`, `hub_url`, `token`), inline `mcpServers` |
| `.claude-plugin/marketplace.json` | Claude Code | A one-plugin marketplace with `source: "./"` |
| `hooks/hooks.json` | Claude Code | The six hook entries, using `${CLAUDE_PLUGIN_ROOT}` |
| `commands/hub-hold.md`, `hub-release.md`, `hub-status.md` | Claude Code | `/hub-hold`, `/hub-release`, `/hub-status` |
| `skills/hub/SKILL.md` | Claude Code, Codex | How a chat should use the hub |
| `plugin.json` (repository root) | Codex and other hosts | agent-plugins.org schema 1.0.0: `skills: "./skills/"`, `extensions.com.openai.hooks: "./hooks/hooks.json"` |
| `mcp.json` (repository root) | same hosts | `mcpServers.unreal-agent-hub` using `${PLUGIN_ROOT}` |

Claude Code install:

```text
/plugin marketplace add <owner>/unreal-agent-hub
/plugin install unreal-agent-hub
```

The root `plugin.json` and `mcp.json` follow the agent-plugins.org schema and are unverified on a live install. Per the authors' notes, Codex runs plugin hooks only for plugins installed manually in the Codex desktop app; for Codex in other setups use `hub install-hooks --agent codex`. `hooks/hooks.json` refers to `${CLAUDE_PLUGIN_ROOT}`, while `mcp.json` uses `${PLUGIN_ROOT}`; whether Codex expands the first is not verified. The plugin's role option defaults to `hub`: on a node set the plugin option `role` to `node` ([CONFIG.md](CONFIG.md)).

## Telling the agent about the hub: `AGENTS.snippet.md`

`AGENTS.snippet.md` is a short block to paste into the `AGENTS.md` (Codex, Cursor) or `CLAUDE.md` of a project that uses the hub. It tells the agent to check `hub status` first, wrap one heavy command with `hub lock <resource> -- <command>`, hold a chain of steps with `hub hold` / `hub release` (or `hub_hold` / `hub_release`), treat "Resource ... is busy" as "do other work", never stop other people's processes or break their locks, and answer "may I take your machine?" requests only with the person's own words. The Claude Code plugin ships the same guidance as the `hub` skill, so Claude Code users do not need the snippet.
