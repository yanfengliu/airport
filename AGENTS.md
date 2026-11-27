# AGENTS.md — airport

## What this is

A browser simulation of San Francisco International Airport: real geometry from OpenStreetMap, and one deterministic simulation of aircraft, air traffic and ground control, road traffic, AirTrain and BART, passengers, baggage, security, shops and staff, drawn in 3D. The plan, its scope and its acceptance criteria are in [the work unit](docs/work/0_sfo-simulation/plan.md).

Non-goals: live flight data or real timetables, airline logos or liveries, satellite imagery, save files, a mobile layout, deployment.

Stack: Vite + TypeScript (strict, erasable syntax only) + three.js; Vitest for the simulation; Playwright driving headless Chromium for anything visual. Desktop browser, one canvas, and the first screen is the running airport.

<!-- FLEET-CANON:BEGIN sha=ed2864572153 generated from ../fleet/FLEET.md by `npm run sync-canon` — do not edit inside this block; this repo's own rules go in docs/policies/local-rules.md -->
## Fleet constitution

Shared rules for every repo under `github/`, kept in `../fleet/FLEET.md`; `../fleet/` is fleet's checkout beside this repo's primary checkout. Where a rule gives its reason, use the reason to judge cases the rule does not name; each `[Rn]`'s history is in `../fleet/docs/canon-rationale.md`. This repo's `docs/policies/local-rules.md` may add rules but cannot change these permissions or limits. [R13]

The main agent owns delivery and may implement directly. Use subagents when bounded, independent work or independent judgment materially improves speed or quality; keep small or tightly coupled work with one agent (owner directive, 2026-11-07). [R2, R3]

The designated coordinator reads `../fleet/docs/skills/coordinator.md` before planning and after each compaction, and any agent reads that file's "Delegate" section before delegating. Before these kinds of work, read the matching section of `../fleet/docs/work-rules.md`: standing loops and unattended runs; editing skills, agent instructions or rules; handing off or stopping mid-task.

### Permissions

- Commit, merge to main and push without asking. Force-pushing and rewriting history (they destroy history), and deploying and publishing (they reach other people), need the owner's OK. [R14]
- Ask before a major architecture or product change, a new major dependency, a change to a persistent format or a security boundary, or any other consequential action outside this machine, such as posting or sending something. [R8]
- Change fleet rules (FLEET.md, fleet skills and runbooks, agent memory) or add a rule to a repo's `docs/policies/local-rules.md` only when the owner asks, because the owner sets policy. You may add a proposal with its evidence to `../fleet/canon-candidates.md`, but not edit its entries. [R8]

### Sharing the machine

- Other Claude and Codex sessions may be working in this checkout, and you cannot see them. Do anything beyond a quick read in your own worktree, because two sessions in one tree spoil each other's gates and commits. Never revert, overwrite or delete changes you did not make. When resuming, check which worktrees, branches and files already exist. [R7]
- Done means merged to main and pushed: the owner archives sessions, and work left on a branch is lost. Merge on your branch, get the gates passing there, then move main, because other worktrees build on local main. Judge the merged result itself, not a worker's summary. Then remove your worktree and branch, and report where any unmerged work is. [R14]

### Doing the work

- The repo's gates must pass on the tree that is handed back or reaches main. Unless the repo's own rules ask more of a commit, commit on your own branch early and often (owner directive, 2026-11-25), after each step that works and at every stopping point, and say in the message what was not checked, because a session can end without warning. Docs-only changes need content checks and any gate the repo names for docs, not runtime tests or CI waits. [R14]
- Check the thing that should have changed (the file, the page, the number), not just the exit code or a tool's report: both can pass over a defect. Retest a blocker you inherit before repeating it. Never weaken a test or hide a failure to get green. [R9]
- Support desktop only unless the owner or product requirements specify another platform. Inspect visual and interactive work at full resolution through real controls, from fixed and random views, because passing tests say nothing about pixels. Run headless unless a visible window is needed. [R16]
- Slowness on the critical path, such as a gate rendering on the CPU of a machine with a GPU, is a defect to fix. [R22]
- After pushing code, follow CI to the end; read a failed job's steps before blaming the code, since a billing limit fails jobs before any step runs. [R15]
- If a fix fails twice for one reason, rethink it. After five real repair attempts at one problem, whatever the approach and counting earlier sessions, stop and report, unless the owner set another limit; for a problem that keeps winning, run the search in `../fleet/docs/skills/hard-problem.md`. Stop when the task's criteria are met; do not invent follow-up work. [R11]
- For substantial or high-risk changes, use independent review when available. High-risk includes persistence and migrations, security and auth, concurrency, money, supply chain, and code changes in another repo. Review the exact revision against the task's criteria, and say so when review was unavailable. Fix the findings that matter and have those fixes checked; note minor ones instead of starting another round. `../fleet/docs/skills/multi-cli-review.md` provides the review mechanics. [R10]
- A defect the owner reports gets a test for its whole class and an entry in `docs/learning/defect-register.md`, because a fix without a check tends to come back. [R17]
- Sessions run long: take new requests in the same session, and never hand off to a new session to shed context. Split work expected to need more than about 200k tokens of context into milestones, each merged to main. [R6]

### Records, sized to the work

- Read `docs/learning/lessons.md` at session start; it lists this repo's known traps, and its header says how to add one. [R18]
- Every change that alters behaviour adds a dated line to `docs/devlog/summary.md` (`../fleet/docs/devlog-template.md`) when it lands, because later sessions orient from its newest entries. Work that spans sessions, has several agents writing, or gets an independent review also keeps its plan and review records in `docs/work/` (`../fleet/docs/work-docs.md`); other work needs none. [R24]
- Raw output (logs, captures, screenshots) stays in ignored folders. Never commit a binary over 512 KiB or any file over 1 MiB; LFS needs the owner's OK. [R23]

### Style and environment

- Plain words; one line per paragraph, no hard wrapping. A report says what changed, how it was checked (including any check skipped or failed) and what is not done. [R25]
- Node 24 is the baseline. Products pin the model IDs they call in their own repo, and nowhere else. Reviewer model pins live only in `../fleet/docs/skills/multi-cli-review.md`. Runtime model calls are allowed and paid for; make per-item calls one-shot, not agent sessions. [R28, R29]
<!-- FLEET-CANON:END -->

## Gates

`npm run typecheck` · `npm test` · `npm run build` · `npm run audit` before every code commit; `npm test` includes the day-long soak tests and the tracked-file size limits. After a change to anything drawn or clicked, `npm run visual` writes full-resolution captures under `artifacts/visual/`: look at them. After a change to `docs/work/`, `node ../fleet/scripts/work-docs.mjs check --repo .`.

## Invariants & boundaries

- `src/sim/` and `src/shared/` import neither three.js nor anything from the DOM, and take every random number from the simulation's seeded source and every time from its clock. That is what lets the same code run under Vitest for a simulated day and give the same answer twice.
- `src/render/` and `src/ui/` read simulation state and never write it; anything the viewer changes goes through a command on the simulation.
- `public/data/*.json` is generated: change `tools/osm/` and run `npm run data:build`, never edit the files. `npm run data:fetch` refreshes the raw extract into ignored `artifacts/osm-raw/`; the raw extract is never committed. The data is OpenStreetMap's under the ODbL, and the attribution in the app, the README and `public/data/provenance.json` stays.
- `public/models/` is generated too: change the lists in `tools/models/polyfork.ts` (Polyfork's free mesh files, CC BY 4.0) or `tools/models/original/` (our own, only for what Polyfork has no model of), run the first, never edit the files. `public/models/CREDITS.md` credits each Polyfork model and says what was changed, and the app's on-screen credit names Polyfork. Only the GLB mesh files are used: Polyfork's source modules (`.mjs`) are under its own licence and are not to be fetched into or committed to this repository. What the simulation lays out is the models' size: `test/interiors.test.ts` (furniture), `test/gse.test.ts` (ground equipment) and `test/outline.test.ts` (aircraft) hold them together.
- Relative imports carry the `.ts` extension, and the code uses no enums, namespaces or parameter properties, so Node runs the tools and the simulation directly.
- Tunable numbers of the simulation live in `src/sim/config.ts`, not in the systems that use them.

## Conventions

- `docs/work/0_sfo-simulation/plan.md` is the status record; `docs/devlog/summary.md` is history, newest first; `docs/learning/lessons.md` is read at session start.
- Task output (raw OSM, captures, logs, the progress gallery at `artifacts/gallery/index.html`) stays under ignored `artifacts/`.
