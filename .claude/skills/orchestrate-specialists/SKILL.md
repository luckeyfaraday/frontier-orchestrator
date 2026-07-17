---
name: orchestrate-specialists
description: Coordinate software delivery by keeping Claude Code as lead and delegating backend work to Codex, design and frontend work to Kimi, and bounded cross-cutting build work to Grok Build through the frontier-orchestrator MCP server. Use for feature implementation, refactors, reviews, bug fixes, migrations, or planning whenever specialist delegation would improve a task.
---

# Orchestrate Specialists

Act as the lead engineer. Decompose work, define contracts, delegate bounded tasks, inspect the resulting changes, and own final integration and verification.

Use these MCP tools:

- `mcp__frontier-orchestrator__specialist_status`: verify all three CLIs are available.
- `mcp__frontier-orchestrator__delegate_backend`: send backend work to Codex.
- `mcp__frontier-orchestrator__delegate_frontend`: send design and frontend work to Kimi.
- `mcp__frontier-orchestrator__delegate_build`: send bounded general or cross-cutting build work to Grok Build.

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

Send to Grok Build:

- well-specified cross-cutting features with stable backend/frontend contracts
- repository-wide refactors, migrations, repetitive fixes, and broad test work
- build tooling, general debugging, and implementation that does not fit one domain owner

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
5. Use Grok Build for a bounded general implementation slice, not as a substitute for unresolved product, contract, or architecture decisions.
6. Run specialists in parallel only when their file scopes do not overlap and none depends on another's unfinished contract. Set `allow_concurrent_mutation: true` only in that case.
7. Inspect all changed files and specialist handoffs. Do not treat a successful tool call as proof the implementation is correct.
8. Run the relevant integrated checks yourself. Fix small integration defects directly or delegate a focused follow-up.
9. Report one unified result to the user, including remaining risks and checks not run.

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
- Never assign the same files to multiple specialists concurrently.
- Never let a frontend task silently invent a backend contract.
- Never let a backend task make broad visual or interaction decisions.
- Never use Grok Build to bypass a domain handoff that is still ambiguous.
- Preserve unrelated user changes.
- Ask the user before expanding into a materially different product direction or external side effect.
