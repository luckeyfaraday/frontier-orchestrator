---
name: orchestrate-specialists
description: Coordinate software delivery by keeping Claude Code as lead and delegating backend work to Codex and design, UI, and frontend work to Kimi through the frontier-orchestrator MCP server. Use for feature implementation, refactors, reviews, bug fixes, or planning that spans server/data/infrastructure and client-facing product work, or whenever specialist delegation would improve a full-stack task.
---

# Orchestrate Specialists

Act as the lead engineer. Decompose work, define contracts, delegate bounded tasks, inspect the resulting changes, and own final integration and verification.

Use these MCP tools:

- `mcp__frontier-orchestrator__specialist_status`: verify both CLIs are available.
- `mcp__frontier-orchestrator__delegate_backend`: send backend work to Codex.
- `mcp__frontier-orchestrator__delegate_frontend`: send design and frontend work to Kimi.

Read [routing-contract.md](references/routing-contract.md) when the task is mixed, the ownership boundary is unclear, or parallel implementation is being considered.

## Route work

Send to Codex:

- APIs, services, databases, migrations, auth, queues, jobs, infrastructure
- security, backend performance, data integrity, backend-focused tests
- server-side architecture and implementation review

Send to Kimi:

- product and interaction design, information architecture, visual direction
- components, styling, responsiveness, accessibility, animation, client state
- frontend architecture, implementation, and visual/frontend review

Keep with Claude:

- task decomposition and priorities
- shared contracts and cross-stack decisions
- resolving contradictory specialist advice
- reviewing diffs, integrating changes, and final verification
- user communication

## Orchestrate

1. Inspect enough of the repository to identify ownership boundaries and constraints.
2. Write explicit acceptance criteria and file scopes for each specialist.
3. For an unknown cross-stack interface, ask Codex to analyze the backend contract first. Pass that contract to Kimi.
4. Delegate implementation only after the boundary is explicit.
5. Run specialists in parallel only when their file scopes do not overlap and neither depends on the other's unfinished contract. Set `allow_concurrent_mutation: true` only in that case.
6. Inspect all changed files and specialist handoffs. Do not treat a successful tool call as proof the implementation is correct.
7. Run the relevant integrated checks yourself. Fix small integration defects directly or delegate a focused follow-up.
8. Report one unified result to the user, including remaining risks and checks not run.

## Build delegation prompts

Supply:

- one concrete task with a clear deliverable
- relevant architecture and decisions, not the whole conversation
- owned files or directories
- observable acceptance criteria
- the existing API or UI contract
- constraints such as compatibility, style, tests, and non-goals

Use `mode: analyze` for planning and contract discovery, `mode: review` for read-only critique, and `mode: implement` for edits.

## Guardrails

- Never delegate the whole ambiguous user request unchanged.
- Never assign the same files to both specialists concurrently.
- Never let a frontend task silently invent a backend contract.
- Never let a backend task make broad visual or interaction decisions.
- Preserve unrelated user changes.
- Ask the user before expanding into a materially different product direction or external side effect.
