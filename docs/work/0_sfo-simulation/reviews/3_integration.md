# Verification of ground operations and passenger interior repairs

## Target

Base `73e3db2`. The reviewed source is Git tree 16f67a6a90425263c00758ea07326bc99efea24a. The binary Git diff is retained locally at `artifacts/reviews/sfo-operations-repairs-1128.patch.gz`.

## Reviewers and coverage

- codex (gpt-6.2-astra, max) — keep.

## Reports

### codex

**No actionable findings.** I inspected all four regression files and ran focused, read-only Node checks. All six repairs and the wing-picking correction addressed the reported cases.

- With 701 seconds until door close, the longest of 240 boarding-group delays was 330 seconds. After close, the delay was zero. With no fuel crew, fueling stayed queued at 0 kg while inspection finished. [Ground-service regressions](test/ground-service.test.ts:55)
- F5 customs arrivals used G’s international claim frontage. All 100 passengers contributed to the expected 14 pickup trips. Departures retained their local share. [Curb demand](src/sim/roads/flight-curbs.ts:87)
- Walkers traversed the T2–T3 gallery in both directions with zero glazing crossings. The renderer builds panes and frames from those same spans. All 39 restroom listings matched their overlay floor, and the B2 and E2 restroom walls were on arrivals. [Interior renderer](src/render/static/interiors.ts:328)
- At 1% interpolation, a ray through the displayed wing picked the correct aircraft for all 11 types. The unchanged pointer handler forwards the click coordinates, and the existing control checks the selected aircraft ID after clicking more than 60 pixels from its center. [Pointer handler](src/render/camera.ts:280) · [Wing-click control](tools/visual/controls.mjs:181)

## Findings and disposition

F113–F118 were independently reproduced and confirmed corrected. The additional real-control wing selection regression covers every aircraft type in the rendered fleet.

## Verification

The read-only reviewer used the furnished pedestrian routes, actual rendered wings, boarding group calls and a simulated F5 international arrival. The browser control suite passed all 37 checks.

## Round outcome

The six reported issues and the interpolated wing case passed recheck. The complete test suite provides additional furnishing and staff placement coverage beyond this round.
