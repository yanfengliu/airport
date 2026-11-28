# Airport operations and public passenger maps

## Target

Base `73e3db2`. The reviewed source is Git tree 3d9de9234bae342f9a94e8443431352019e21c3a. The binary Git diff is retained locally at `artifacts/reviews/sfo-operations-1128.patch.gz`.

## Reviewers and coverage

- codex (gpt-6.2-astra, max) — keep.

- claude (claude, max) — abstain.

## Reports

### codex

**I found six issues to correct before landing.**

1. **Late cabin cleaning can make passengers already at the gate miss their flight.** In a controlled 240-passenger 787-9 turnaround, the gate closed 701 seconds after cabin release. The final boarding group waits at least 1,075 seconds to be called. Calculate group delays from the time remaining when boarding actually opens. [airside.ts:609](src/sim/airside/airside.ts:609) · [terminals.ts:1317](src/sim/terminal/terminals.ts:1317)

2. **Customs pickups can go to the wrong terminal.** Seed 7 schedules a United arrival from Mexico City at F5. Its passengers go to baggage claim G, while its pickup cars use F’s curb links. Use the passenger simulation’s customs-hall selection before choosing the pickup curb. [flight-curbs.ts:71](src/sim/roads/flight-curbs.ts:71) · [terminals.ts:1448](src/sim/terminal/terminals.ts:1448)

3. **Customs pickup demand is undercounted.** For 100 United passengers clearing customs, the road model generates 9.8 represented trips. All 100 go landside in the passenger simulation, which gives 14 trips at the configured rate. Use the full inbound passenger count for customs pickups and apply the connecting share separately to departures. [flight-curbs.ts:96](src/sim/roads/flight-curbs.ts:96) · [terminals.ts:1425](src/sim/terminal/terminals.ts:1425)

4. **Walkers cross glass walls in the T2–T3 gallery.** I ran a walker from D1 to E4 and back on the furnished plan. Each direction crossed two rendered T2 wall segments and one T3 segment. The renderer tests only the midpoint of each whole edge. Split the edges at the gallery openings and omit the glass and framing there. [interiors.ts:229](src/render/static/interiors.ts:229) · [unchanged walking call in people.ts:466](src/sim/terminal/people.ts:466)

5. **Two restroom listings select a floor where the rooms are missing.** The map sends users to Arrivals for the restrooms near B2 and E2. The cutaway draws all restroom floors and walls upstairs. Use the same per-room floor assignment for the directory and renderer. [terminal-map-data.ts:109](src/ui/terminal-map-data.ts:109) · [interiors.ts:288](src/render/static/interiors.ts:288)

6. **An empty fuel crew pool produces `NaN` fuel and job times.** With zero fuel crews, dispatch assigns crew `0` and reads its nonexistent availability. Skip assignment when the pool is empty so the job stays queued with zero fuel delivered. [ground-service.ts:82](src/sim/airside/ground-service.ts:82)

Verification used read-only, in-memory checks against the changes since `73e3db2`. The expensive gates were skipped as requested.

### claude

expected 1 result event, got 0; result text is empty or non-string; expected 1 model in modelUsage, got 0 (none); timed out after 900s

## Findings and disposition

F113. Late cabin release now shortens group-call delays to the actual boarding window. F114 and F115. Actual customs halls supply the pickup curb and all arriving customs passengers count toward pickup demand. F116. Gallery wall and frame edges now open at the traversable entrances. F117. The renderer and directory share mapped restroom levels. F118. An unavailable team leaves jobs queued. All six findings were accepted.

## Verification

Focused checks reproduce late boarding, an empty crew pool, inbound hall selection and pickup demand, furnished transfers in both directions, and downstairs restroom locations.

## Round outcome

The fixes and their proving tests were submitted for the next independent round.
