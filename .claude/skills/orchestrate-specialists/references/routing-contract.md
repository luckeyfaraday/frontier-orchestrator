# Routing and Integration Contract

## Ownership matrix

| Area | Primary specialist | Required handoff |
| --- | --- | --- |
| API routes, service logic, auth, persistence | Codex | Endpoint, method, request/response/error shapes, auth assumptions |
| Schema and migrations | Codex | New fields, nullability, rollout and compatibility notes |
| Infrastructure, jobs, queues, observability | Codex | Runtime/configuration impact and failure modes |
| Page structure, user flows, visual hierarchy | Kimi | Interaction states, component boundaries, responsive behavior |
| Components, CSS, client state, accessibility | Kimi | Backend data assumptions and frontend verification |
| Cross-cutting implementation with stable contracts | Grok Build | Files changed, preserved contracts, integrated verification |
| Repository-wide refactors, migrations, build tooling | Grok Build | Compatibility impact, migration notes, checks run |
| Shared types or generated clients | Claude decides owner | Source of truth, generation command, compatibility impact |
| End-to-end behavior | Claude | Integrated acceptance result |

## Sequencing

Use backend-first sequencing when the UI depends on a new or unclear contract:

1. Ask Codex for `mode: analyze`.
2. Normalize the contract and resolve open questions.
3. Give Kimi the accepted contract.
4. Implement backend and frontend sequentially, or in parallel only if the contract is stable and file scopes do not overlap.
5. Run integrated checks.

Use frontend-first discovery when product behavior is unclear:

1. Ask Kimi for `mode: analyze` to define the flow, states, and data needs.
2. Convert data needs into an explicit backend contract.
3. Ask Codex to validate or implement that contract.
4. Give the final contract back to Kimi for implementation.

Use parallel implementation only when all conditions are true:

- the contract is already accepted;
- owned file scopes are disjoint;
- no task generates files owned by another specialist;
- every specialist can verify its part independently;
- Claude will perform integration checks afterward.

Use Grok Build only after the relevant backend, frontend, and shared contracts are explicit. Give it a bounded file scope and acceptance criteria; keep unresolved product behavior and architecture decisions with Claude or the appropriate domain specialist.

## Handoff checklist

Require each specialist to return:

- a concise summary;
- exact files changed;
- commands run and their outcomes;
- the cross-specialist contract;
- risks, assumptions, and follow-ups.

Treat missing handoff details as incomplete work. Inspect the code rather than inferring them.

## Conflict resolution

When specialists disagree:

1. Prefer repository constraints and user requirements over either specialist's preference.
2. Prefer the smallest stable interface that satisfies current acceptance criteria.
3. Keep product/interaction authority with Kimi, server/data authority with Codex, and bounded cross-cutting execution with Grok Build.
4. Keep final architectural and integration authority with Claude.
5. Delegate a narrow read-only review if evidence is insufficient; do not bounce the full task back and forth.
