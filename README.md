# Frontier Orchestrator — Multi-Agent Orchestration for Claude Code

[![CI](https://github.com/luckeyfaraday/frontier-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/luckeyfaraday/frontier-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-brightgreen)](package.json)

**Frontier Orchestrator** is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server and Claude Code skill that turns Claude into the **lead engineer of a multi-agent team**. Claude decomposes tasks, defines cross-stack contracts, and verifies results — while delegating:

- **Backend work** (APIs, databases, migrations, auth, infrastructure, security, backend tests) to **OpenAI Codex**
- **Frontend and design work** (UI, UX, components, styling, accessibility, animation, client state) to **Kimi Code**
- **Tooling and mechanical maintenance** (build configuration, dependency upgrades, CI, release automation, generated boilerplate, repository transformations, test/lint cleanup) to **Grok Build**

Each specialist runs as a sandboxed subprocess in your repository, receives a role-scoped brief with explicit file ownership and acceptance criteria, and reports back in a structured format that Claude reviews before anything reaches you.

## Why multi-agent orchestration?

Frontier coding agents have different strengths. Instead of asking one model to do everything, Frontier Orchestrator routes each part of a full-stack task to the agent best suited for it — with **enforced coordination discipline** so agents never trample each other's changes:

- **Domain-first routing** — backend behavior goes to Codex, frontend and UX behavior goes to Kimi, and only domain-neutral tooling or mechanical maintenance goes to Grok unless you explicitly override routing. Grok is never selected solely because it is faster.
- **Workspace mutation guard** — two specialists cannot edit overlapping directories at the same time unless Claude explicitly certifies their file scopes are disjoint.
- **Contract-first sequencing** — for an unknown cross-stack interface, Codex analyzes the backend contract first; Kimi builds against the accepted contract. A frontend task can never silently invent a backend API.
- **Read-only modes** — `analyze` and `review` delegations run the specialist CLI in a read-only sandbox; only `implement` may edit the workspace.

## How it works

```mermaid
flowchart LR
    U[You] --> C[Claude Code<br/>lead engineer]
    C -->|delegate_backend| M[frontier-orchestrator<br/>MCP server]
    C -->|delegate_frontend| M
    C -->|delegate_build| M
    M -->|codex exec<br/>sandboxed| X[OpenAI Codex<br/>backend specialist]
    M -->|kimi -p<br/>sandboxed| K[Kimi Code<br/>frontend specialist]
    M -->|grok -p<br/>sandboxed| G[Grok Build<br/>tooling/maintenance specialist]
    X --> M
    K --> M
    G --> M
    M -->|structured JSON result| C
    C -->|reviewed, integrated,<br/>verified result| U
```

The MCP server exposes four tools:

| Tool | Purpose |
| --- | --- |
| `specialist_status` | Check that the Codex, Kimi, and Grok CLIs are installed and report versions |
| `delegate_backend` | Send a bounded backend task to Codex (`analyze` / `review` / `implement`) |
| `delegate_frontend` | Send a bounded design/frontend task to Kimi (`analyze` / `review` / `implement`) |
| `delegate_build` | Send domain-neutral tooling or mechanical maintenance to Grok Build (`analyze` / `review` / `implement`) |

Each delegation takes a structured request — `task`, `mode`, `context`, `file_scope`, `acceptance_criteria`, optional `model` override, and a hard `timeout_seconds` (default 3600, max 7200) — and returns JSON with the specialist's final message, exit code, duration, and diagnostics on failure.

The companion **`orchestrate-specialists` skill** (in `.claude/skills/`) teaches Claude the domain-first routing rules, backend-first and frontend-first sequencing patterns, Grok's tooling and maintenance boundary, parallelization preconditions, and guardrails (see [routing-contract.md](.claude/skills/orchestrate-specialists/references/routing-contract.md)).

## Quick start

Requirements: Node.js 20+, [Claude Code](https://claude.com/claude-code), and authenticated `codex`, `kimi`, and `grok` CLIs for the specialists you intend to use. A missing optional CLI only makes that specialist unavailable.

Kimi requires [Kimi Code](https://moonshotai.github.io/kimi-code/) 2.x (`npm install -g @moonshot-ai/kimi-code`). The legacy Python `kimi-cli` flags (`--print`, `--work-dir`, `--final-message-only`) are no longer used; run `kimi migrate` to move existing kimi-cli data into Kimi Code.

```bash
git clone https://github.com/luckeyfaraday/frontier-orchestrator.git
cd frontier-orchestrator
npm install
npm run build
```

Launch Claude Code from this repository. Claude discovers the project-scoped `.mcp.json` and the skill automatically. Approve the MCP server when prompted, then run:

```text
/orchestrate-specialists
```

Verify the connection with `/mcp` or:

```bash
claude mcp get frontier-orchestrator
```

## Use from any project

Install the MCP server at user scope:

```bash
npm install && npm run build && npm link
claude mcp add --scope user frontier-orchestrator -- frontier-orchestrator
```

Copy the skill to user scope:

```bash
mkdir -p ~/.claude/skills
cp -R .claude/skills/orchestrate-specialists ~/.claude/skills/
```

`claude mcp add` does not set a tool-call timeout. Add `"timeout": 7500000` to the `frontier-orchestrator` entry under `mcpServers` in `~/.claude.json`, matching the project `.mcp.json`; otherwise slow specialists such as Codex at high reasoning effort can be cut off by the client before their own `timeout_seconds` expires.

Restart Claude Code after changing MCP configuration.

## Example delegation

A typical full-stack feature flows like this:

1. Claude inspects the repo and writes acceptance criteria plus file scopes for each side.
2. `delegate_backend` with `mode: analyze` — Codex proposes the API contract.
3. Claude normalizes the contract and passes it to Kimi.
4. `delegate_backend` and `delegate_frontend` with `mode: implement` — run sequentially, or in parallel only when file scopes are disjoint (`allow_concurrent_mutation: true`). Separate domain-neutral tooling or mechanical maintenance can go to `delegate_build`; a stable application contract does not transfer backend or frontend ownership to Grok.
5. Claude inspects every changed file, runs the integrated checks, fixes small integration defects, and reports one unified result.

## Configuration

The server inherits existing Codex, Kimi, and Grok authentication from their CLIs. All settings are environment variables:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `FRONTIER_PROJECT_ROOT` | `CLAUDE_PROJECT_DIR` | Base workspace for relative paths |
| `FRONTIER_ALLOWED_ROOTS` | project root | Additional allowed roots, separated by the platform path delimiter |
| `FRONTIER_CODEX_CLI` | `codex` | Codex executable or absolute path |
| `FRONTIER_KIMI_CLI` | `kimi` | Kimi Code executable or absolute path |
| `FRONTIER_GROK_CLI` | `grok` | Grok executable or absolute path |
| `FRONTIER_MAX_CONCURRENCY` | `2` | Maximum simultaneous specialist processes |
| `FRONTIER_MAX_CAPTURED_BYTES` | `2000000` | Per-stream child output retained in memory |
| `FRONTIER_MAX_RESULT_CHARS` | `30000` | Maximum specialist text returned to Claude |
| `FRONTIER_IDLE_TIMEOUT_SECONDS` | `900` | Stop Codex or Kimi after this many seconds without any output; `0` disables. Grok's plain output arrives only at the end, so it is exempt |

Keep the MCP client `timeout` (milliseconds) above the 7200-second `timeout_seconds` maximum so the server, not the client, ends an overrunning specialist and returns its partial output. If the client cancels a request anyway, the server terminates the specialist process and releases its workspace lock.

`timeout_seconds` is a ceiling, not a budget. Stuck Codex and Kimi runs are caught by the idle limit instead, so delegations should keep the default rather than shortening it or splitting work by time. When a run does hit a limit, the result includes `timed_out` or `idle_timed_out` and a hint to inspect the partial work and delegate only what remains.

Implementation calls are serialized per working directory unless Claude explicitly sets `allow_concurrent_mutation: true`. The skill only permits that when file scopes are disjoint and the cross-stack contract is stable.

## FAQ

**What is Frontier Orchestrator?**
A local stdio MCP server plus a Claude Code skill that lets Claude orchestrate OpenAI Codex, Kimi Code, and Grok Build as specialists — Codex for backend engineering, Kimi for design and frontend, and Grok for domain-neutral tooling and mechanical maintenance — while Claude remains responsible for decomposition, contracts, review, and integration.

**How is this different from Claude Code subagents?**
Subagents run more instances of Claude. Frontier Orchestrator routes work to *different frontier models* by domain and workload strength, wrapped in file-scope and mutation guardrails, with Claude reviewing everything before completion.

**Does it need API keys?**
No keys of its own. It shells out to the `codex`, `kimi`, and `grok` CLIs and inherits whatever authentication those CLIs already have.

**Can specialists run in parallel?**
Yes, up to `FRONTIER_MAX_CONCURRENCY` processes — but workspace mutations are serialized per directory unless Claude explicitly certifies disjoint file scopes.

**Is it safe to let specialists edit my repo?**
`analyze` and `review` modes are read-only. `implement` uses each provider's workspace-editing mode and instructs every specialist to stay inside its declared file scope; Claude inspects all diffs before presenting completion.

## Troubleshooting

- `LLM not set` from Kimi means no provider/model is configured. Run `kimi login`, complete the browser authorization and model selection, then retry.
- Authentication errors from Grok mean its CLI session is unavailable or expired. Run `grok login`, then confirm the account's available models with `grok models`.
- A project-scoped MCP server appears as pending until you open Claude Code in the repository and approve `.mcp.json`.
- On Windows, npm installs CLIs as `.cmd` shims, which Node cannot spawn without a shell. The server resolves npm shims on `PATH` to their JavaScript entry and runs it with the current Node. A `FRONTIER_*_CLI` value may also point directly at a native `.exe` or a `.js`/`.mjs`/`.cjs` entry. Timeouts and cancellations terminate the whole specialist process tree.
- `specialist_status` checks executable availability and versions; a real delegation is the definitive authentication/configuration check.

## Development

```bash
npm run check   # typecheck
npm test        # build + node --test
```

Source layout: `src/index.ts` (MCP server and tools), `src/specialists.ts` (Codex, Kimi, and Grok CLI invocations and specialist prompts), `src/coordinator.ts` (concurrency gate and workspace mutation guard), `src/config.ts` (environment configuration and path allow-listing), `src/process.ts` (subprocess lifecycle).

## License

[MIT](LICENSE) © luckeyfaraday
