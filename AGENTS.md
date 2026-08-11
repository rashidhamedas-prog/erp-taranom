# AI-DOS Shared Agent Contract

This file governs every AI tool and human contributor in this repository. More-specific `AGENTS.md` files may add constraints but must not weaken security, ownership, or quality gates here.

## Start of every session

Read, in order: this file, `.ai-dos/ai-dos.yaml`, `.ai-dos/project/overview.md`, `.ai-dos/project/architecture.md`, `.ai-dos/project/status.md`, `.ai-dos/tasks/active.yaml`, and `.ai-dos/tasks/handoff.md`. Treat repository evidence as authoritative; mark unknown facts instead of inventing them.

## Roles

- Orchestrator: decomposes work, assigns owners, resolves dependencies, and enforces gates.
- Architect: defines boundaries, invariants, ADRs, acceptance criteria, and migration/rollback strategy.
- Implementer: changes only the assigned task and claimed files; supplies tests and evidence.
- Reviewer: independently reviews the diff, edge cases, regressions, and acceptance criteria.
- Security: reviews trust boundaries, auth, secrets, inputs, dependencies, and abuse cases.

One agent may hold multiple roles only when recorded in the task. High-risk changes require Reviewer and Security identities distinct from Implementer.

## Ownership and concurrency

`.ai-dos/tasks/active.yaml` is the source of truth. Before editing, create or claim a task with one owner, branch, worktree, acceptance criteria, and explicit `file_claims`. Do not edit a file claimed by another active task. Glob claims are discouraged; shared/generated/lock files require an explicit handoff. A stale claim may be reclaimed only after recording the reason and notifying the previous owner in `.ai-dos/tasks/handoff.md`.

Use one branch and preferably one Git worktree per task. Branch format: `ai/<task-id>-<slug>` (or `fix/`, `feat/`, `chore/`). Never share a worktree between simultaneous writers. Rebase/merge the base branch before final review and resolve conflicts in the owning task.

## Execution protocol

1. Discover verified context and current tests.
2. Define scope, non-goals, acceptance criteria, risk, rollback, and validation.
3. Claim task and files before modification.
4. Make the smallest coherent change; do not rewrite unrelated user work.
5. Run configured gates and attach commands/results to handoff.
6. Obtain independent review appropriate to risk.
7. Update project status and handoff; release claims only after commit or explicit abandonment.

Stop and escalate on conflicting claims, unclear destructive action, missing authority, secrets exposure, or an architectural choice that materially changes scope.

## Context budget

Load progressively: contract/status/task first, then only relevant architecture and files. Prefer summaries and exact paths over raw logs. At the threshold configured in `ai-dos.yaml`, create a checkpoint in `handoff.md`: objective, decisions, changed files, tests, failures, next action, and unresolved risks. Start a fresh session at phase boundaries or after compaction.

## Quality and security

All enabled gates in `.ai-dos/ai-dos.yaml` must pass or have a recorded, approved exception. New behavior needs proportionate tests. Never commit secrets, weaken auth/TLS, execute untrusted input, or add dependencies without review. Report findings by severity with file/evidence, impact, and remediation. “Done” means acceptance criteria met, tests recorded, review complete, documentation updated, and handoff usable by a fresh agent.
