# Contributing

Thank you for helping. Bug reports, agent payloads from new versions of Claude Code, Codex or Cursor, profiles for
other tools and fixes are all welcome.

## Before you start

- **Contributor License Agreement.** Pull requests are accepted only with the [CLA](CLA.md): tick the box in the
  pull request template. The project is dual-licensed (PolyForm Small Business + commercial), and the CLA is what
  keeps that possible. Issues need no CLA.
- **Bigger changes:** open an issue first, so we agree on the shape before you write the code.
- **Security issues:** never in a public issue; see [docs/SECURITY.md](docs/SECURITY.md#reporting).
- **Commercial license questions:** an issue or discussion with the label `commercial-license`, or e-mail; see
  [COMMERCIAL.md](COMMERCIAL.md).

## Working on the code

- Node.js 18 or newer, **no npm dependencies** - please keep it that way. The board uses vendored React and htm
  from `web/vendor/`; no build step.
- Tests: `npm test` (node:test). Add a test for every change in the lock protocol, the queue or the agent formats;
  a new agent payload goes into `test/fixtures/<agent>/` together with a link to the documentation it follows.
- The lock protocol is a contract with clients in other languages ([docs/PROTOCOL.md](docs/PROTOCOL.md)): change
  it only together with the document.
- Rules the project keeps on every machine: fail open (a hub error never blocks work), never stop or kill a
  process, never touch ssh keys, no tray apps or windows of our own on nodes.
- Texts: English for code, docs and the board's `en.json`; other languages in `web/i18n/` follow `en.json` key by key.

## Pull requests

One topic per pull request, a short description of what changed and how you checked it, `npm test` green.
