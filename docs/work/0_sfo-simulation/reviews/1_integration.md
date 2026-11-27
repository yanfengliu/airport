# Review 1: the repairs checked

## Target

The repairs of round 0 ([0_integration.md](0_integration.md)) at commit `2222006` on branch `sfo-sim` (2026-11-26), read as a clean copy made by `git archive 2222006`, with no git history and nothing installed. Each repair that changes behaviour was given to the lane by its finding ID, with the commit that made it and the test or run that should catch the defect if it came back.

## Reviewers and coverage

One lane, as the fleet runbook (`../fleet/docs/skills/multi-cli-review.md`) asks for a round of repairs: Codex, `gpt-6-astra` at `xhigh`, read-only sandbox, `--skip-git-repo-check` for the same reason as round 0, run from `../fleet/tmp/review-runs/airport-m6-r1-2222006/`, three lenses one after another, each from a prompt of its own listing its finding IDs: airside, ground control, stands and the airside benchmark; roads, trains, people, bags and the map data; drawing, interface, app and the visual tools. Asked of each ID: is it fixed, would its check fail if the defect came back, and did the repair break anything near it.

One repair landed after the target and is not in this round: F66 (877324d, staff hand over their posts at each shift; the shops close at night), a low finding, covered by its own test, which fails without it.

<!-- coverage -->

## Reports

### Codex (gpt-6-astra, xhigh): airside, ground control, stands and the airside benchmark

<!-- report: codex-airside -->
<!-- end -->

### Codex (gpt-6-astra, xhigh): roads, trains, people, bags and the map data

<!-- report: codex-ground -->
<!-- end -->

### Codex (gpt-6-astra, xhigh): drawing, interface, app and the visual tools

<!-- report: codex-interface -->
<!-- end -->

## Findings and disposition

| ID | Finding | Disposition and reason | Repair or follow-up |
|---|---|---|---|

## Verification

Not yet available: the lane was started at 18:38 on 2026-11-26 and its reports are awaited. What was run on any repair it leads to is recorded here when done.

## Round outcome

Open: awaiting the lane's reports.
