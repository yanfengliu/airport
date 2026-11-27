# Review 0: integration

## Target

The integrated build of the whole repository at commit `b0b42a4` on `main` (2026-11-26): every tracked file, read as a clean copy made by `git archive b0b42a4`, with no git history and nothing installed. The review is against the acceptance criteria in [plan.md](../plan.md) and the invariants in `AGENTS.md`.

## Reviewers and coverage

Both lanes of the fleet runbook (`../fleet/docs/skills/multi-cli-review.md`), run from `../fleet/tmp/review-runs/airport-m6-b0b42a4/`, outside the reviewed copy, each lane with its own run folder.

- Codex, `gpt-6-astra` at `xhigh`, read-only sandbox, five lenses run one after another, each from a prompt of its own: airside; people, queues and bags; roads and transit; drawing, interface and app; map data, shared code, gates and records. Told to read the files itself, not through subagents.
- Claude, `claude-opus-5-5[1m]` at `--effort max`, with the runbook's limits, one run that gave each of the same five lenses to a built-in subagent and checked their findings before reporting.

Deviations from the runbook, each with its reason:
- Codex was given `--skip-git-repo-check`: the reviewed copy is an archive, not a git checkout, and Codex refuses to start in one without it ("Not inside a trusted directory"). The sandbox stays read-only.
- The installed Claude Code is 2.1.329, not the 2.1.308 the lane's limits were proven on, so they were proven again first with a probe from a new one-commit folder: the lane got exactly Task, Bash, Glob, Grep and Read, `dontAsk`, no MCP servers; a redirect, `mkdir` and `git diff --output` were refused, `git diff --stat` ran; the subagent ran on the lane's model, offered no model choice and could not write; nothing was left in the folder. On this build the one `modelUsage` key is `claude-opus-5-5` with `contextWindow` 1,000,000, not `claude-opus-5-5[1m]`: the 1M window took effect and only the key's name changed, so a lane passes here with that single key and that window.

Coverage as run. The Codex lenses ran one after another from one script, and every one exited 0 and wrote its report; an empty report seen early was a lens still running, not a failure. The Codex lenses ran read-only Node probes on the copy (seeds, scenarios, fault injections), and say so in their reports. The Claude lane ran 97 turns, its five lens subagents and its own check of their findings, and reported a single `modelUsage` key, `claude-opus-5-5`, with the 1M window; its sandbox refused `node`, so its findings come from reading the code and data, with arithmetic, and none of them is a run. No lane changed a file.

## Reports

### Codex (gpt-6-astra, xhigh): airside

<!-- report: codex-airside -->

Found **9 issues** in the Airside lens at `b0b42a4`.

1. **Closed runways still grant new departure clearances — high.**  
   [tower.ts:325](src/sim/airside/tower.ts:325) never checks closure before granting line-up; `departureEndsFor` also returns closed runways when all alternatives are closed. **Reproduced:** seed 7, starting at 15:00; close 01L while DL 242 is taxiing toward it without clearance. It starts take-off 296 seconds later, with 01L still closed. The closure test closes before traffic starts, missing this case. Reject new line-up clearances on closed runways and hold or reroute uncleared departures; preserve existing clearances. **Confidence: high.**

2. **Arrivals delayed six hours become permanently unscheduled — medium.**  
   [airside.ts:359](src/sim/airside/airside.ts:359) stops considering visits whose scheduled arrival is over six hours old, without completing or otherwise resolving them. **Reproduced:** seed 7, close both arrival runways from 06:00 until 13:00. AS 949, scheduled at 06:32, remains `scheduled`, with `aircraft = -1` and no landing after reopening; 52 other arrivals land by 14:00. Its eligibility can never return. Keep unresolved arrivals eligible until they receive a disposition. **Confidence: high.**

3. **A super-heavy slot can invalidate an already assigned following slot — medium.**  
   [tower.ts:220](src/sim/airside/tower.ts:220) adds wake-protection holes without checking whether those slots already contain arrivals. **Reproduced:** assign a medium aircraft to 28L at 256 seconds, then a super-heavy to 28L at 128 seconds. Both assignments succeed; the 256-second slot is simultaneously occupied and required empty. Slot reassignment can allocate out of chronological order. Reject such a super-heavy placement or reslot the affected following arrival. **Confidence: high in the allocator defect; not observed in the sampled normal days.**

4. **Visibility changes reinterpret old slot reservations as future reservations — medium.**  
   [tower.ts:191](src/sim/airside/tower.ts:191) changes the slot length, but reservations and holes remain keyed by slot number; [tower.ts:227](src/sim/airside/tower.ts:227) interprets those keys using the new length. A reservation at 12,000 seconds under 120-second spacing therefore blocks 12,800 seconds under 128-second spacing. **Reproduced in Sim:** seed 7, low cloud from 13:30 to 15:30, then clear weather leaves 22 ghost reservations on 28R during the following hour. Key reservations by absolute time, preserving their original spacing. **Confidence: high.**

5. **The soak does not measure completion of full flight cycles — high.**  
   [soak.ts:206](tools/sim/soak.ts:206) compares cumulative landings and take-off clearances against one day’s rotation count. It neither matches the two movements to the same visits nor requires `done`. **Observed:** seed 7 passes with 593 landings and 590 take-offs, while only 522 of the 589 visits scheduled to arrive during the measured day have completed by the end. Overnight departures and next-day movements contribute to the passing totals. This does not itself prove those overnight visits are late; it proves the benchmark does not establish the stated full-cycle criterion. Define the eligible cohort and count completed visits by ID, handling overnight boundaries explicitly. **Confidence: high.**

6. **The runway-conflict detector exempts landing traffic ahead — medium.**  
   [soak.ts:102](tools/sim/soak.ts:102) ignores any aircraft ahead moving in the same direction above 50 m/s. It checks neither departure phase nor whether that aircraft is pulling away. **Reproduced using the actual detector:** two landing rolls, 100 metres apart, trailing aircraft at 75 m/s and leading aircraft at 55 m/s, produce zero conflicts. Such a separation violation can escape this measure. Restrict the exemption to the intended departure case and check separation or relative motion. **Confidence: high.**

7. **The required test gate omits the day-long airside benchmark — medium.**  
   [test/sim.test.ts:13](test/sim.test.ts:13) checks traffic over two hours; its six-hour runs check only repeatability. `npm test` runs Vitest, and no test invokes the airside soak. An evening deadlock or collision can therefore pass the required gate, contrary to AGENTS.md’s statement that it includes day-long soaks. Add the airside benchmark to that gate. **Confidence: high.**

8. **Operational tuning remains outside `config.ts` — low.**  
   Examples include passing costs and fairness limits in [traffic.ts:26](src/sim/airfield/traffic.ts:26), weather thresholds in [weather.ts:31](src/sim/weather.ts:31), and departure capacity in [schedule.ts:165](src/sim/schedule.ts:165). These directly tune simulation behaviour, violating the explicit configuration invariant. Move them into `CONFIG`. **Confidence: high.**

9. **Aircraft jump backward when leaving the landing roll — medium.**  
   [aircraft.ts:676](src/sim/airside/aircraft.ts:676) transfers the runway position into the path’s lead-point coordinate without accounting for the fuselage-centre offset used by `fuselageAt`. The renderer interpolates the resulting position change. **Reproduced:** seed 7’s AS 949 and HA 1696 each move 14.76 metres backward during their first taxi movement after rollout, despite reporting 20.82 m/s forward speed. Convert consistently between centre and lead-point coordinates at the transition. **Confidence: high.**

Checks performed: seed 7’s 26-hour soak passed; seed 11’s 26-hour trace found no fuselage meetings or sampled journey-order violations; the six-hour storm scenario passed. The targeted probes above exposed defects those runs miss.

No additional findings in the reviewed airside randomness/clock handling or UI command routing: [sim.ts:99](src/sim/sim.ts:99), [main.ts:142](src/app/main.ts:142).

No files changed. Vitest, build and rendered visual checks were not run; dependencies are absent.

<!-- end -->

### Codex (gpt-6-astra, xhigh): people, queues and bags

<!-- report: codex-people -->

Reviewed **b0b42a4**, limited to people, queues and bags. Found ten issues.

1. **Passengers board at obsolete gates — high; reproduced.**  
   [terminals.ts:838](src/sim/terminal/terminals.ts:838) redirects only passengers currently waiting when boarding opens. Walking passengers retain their old gate scripts, and boarding does not verify their gate. In seed 3, starting at 04:00 and running six hours, **55 passengers boarded through the wrong gate**; examples used F15 while their aircraft was at F6, about 190 metres away. Update affected scripts after gate changes and validate the boarding gate before counting passengers aboard.

2. **Mid-day initialization discards bags — high; reproduced.**  
   [terminals.ts:502](src/sim/terminal/terminals.ts:502) creates passengers already through security but ignores their `bags` argument. `addParty` initializes their bag count to zero. At a 07:00 start with seed 3, **557 planned bags belonging to 599 parties disappear from accounting**. Initialize these bags into an accounted-for state before returning.

3. **Cancelled flights retain fictitious loaded bags — medium; reproduced.**  
   [terminals.ts:779](src/sim/terminal/terminals.ts:779) records bags as loaded immediately at check-in, then retains only readiness time and count. Flight and owner associations are lost. A probe checked two bags for an aircraft that never arrived; automatic cancellation sent its passenger home, but both bags remained “loaded” and their moving records disappeared. Preserve flight/owner associations until actual loading or return, and reconcile cancellation.

4. **Reused person IDs can strand queue customers forever — medium; reproduced.**  
   [queue.ts:95](src/sim/terminal/queue.ts:95) removes waiting entries but leaves `server.serving` intact. If that person leaves and their slot is reused by someone joining the same queue, the old completion passes the guard at [people.ts:411](src/sim/terminal/people.ts:411). The replacement is completed prematurely, then called again with its queue association cleared. The probe ended with an alive passenger permanently `ACT.served`, `queue = -1`, and every server idle. Clear active service references when removing/reassigning customers, or validate an allocation generation.

5. **Connecting passengers have no journey path — high; high confidence.**  
   [terminals.ts:719](src/sim/terminal/terminals.ts:719) sends every arriving party out of the building; none is assigned an onward flight. Departures are independently generated. Thus balanced totals cannot establish the acceptance criterion that connecting passengers complete journeys: no connections occur. Add an onward-flight handoff for connecting parties, including their bags, and check that such journeys actually complete.

6. **The floor plan drops the BART entrance — high; reproduced.**  
   [plan.ts:367](src/sim/terminal/plan.ts:367) accepts stations within a 140-metre search, but `add` searches only 60 metres. The committed SFO BART station’s nearest landside cell is about **100 metres away**, so no BART entrance is created. BART-selected departures silently fall back to the curb. Reuse the cell already found, or pass the intended search reach into `add`, and assert the entrance exists.

7. **Capacity exhaustion loses departing passengers — medium; reproduced.**  
   [terminals.ts:491](src/sim/terminal/terminals.ts:491) increments `created` before allocation; allocation failure simply returns after the pending arrival was consumed. At 40,000 occupied slots, another departure increased `created` without creating a person or recording an outcome. Arrivals instead count failed allocations as having left at line 645. Keep unsuccessful spawns pending and advance journey/accounting counters only after successful allocation.

8. **The day-long acceptance runner cannot reject failures — high; reproduced.**  
   [tools/sim/people.ts:71](tools/sim/people.ts:71) calculates and prints balances but never asserts them or sets a failure exit status. An in-memory fault injection produced **28,800 unaccounted departing passengers**, yet the runner exited **0**. Excessive misses and waits likewise only print. Add explicit acceptance checks and a nonzero exit status.

9. **The bag test permits bags to disappear — high; high confidence.**  
   [people.test.ts:41](test/people.test.ts:41) checks `loaded + leftBehind + misrouted <= checked`. Keeping `checked` above 2,000 while dropping every outgoing bag without recording any outcome satisfies that assertion and improves the mishandling percentage. No incoming-bag conservation identity is checked either. Require exact conservation across terminal outcomes and explicitly counted bags still in transit.

10. **Terminal behavior bypasses the required configuration boundary — low; certain.**  
    [terminals.ts:404](src/sim/terminal/terminals.ts:404) embeds arrival distributions and bag probabilities; [terminals.ts:814](src/sim/terminal/terminals.ts:814) embeds service rates. These are simulation tunables explicitly required to live in `CONFIG`. Move them there without changing their values.

**Checks and limits:** The unmodified 24-hour seed-3 run balanced passenger totals and reported 0.01% missed flights. Dependency-free probes reproduced the failures above. Synthetic 40,000-agent people/queue steps took approximately 3.1–3.4 ms; this excludes the full simulation and rendering. Vitest and browser checks were not run because dependencies were absent.

**No findings** of wall-clock/random-source violations in this lens, or direct terminal-state mutation by the inspected UI: [terminals.ts:371](src/sim/terminal/terminals.ts:371) receives simulation time, and [main.ts:155](src/app/main.ts:155) routes checkpoint changes through `Sim`. No additional visual defects established. No files changed.

<!-- end -->

### Codex (gpt-6-astra, xhigh): roads and transit

<!-- report: codex-roads -->

Review of **b0b42a4**, limited to roads and transit. I found the following defects.

1. **Lane changes allow cars to collide — high; confidence: high.**  
   [traffic.ts:605](src/sim/roads/traffic.ts:605) removes a vehicle from its source lane immediately, although its body takes 2.4 seconds to move across. With seed 7, starting at 07:30, cars 2041 and 2037 swap lanes on US-101 at 07:36:20.5. Their longitudinal separation is 3.99 m and lateral separation 1.36 m; their bodies are 4.6 × 1.82 m, so they intersect. [overlaps():118](src/sim/roads/traffic.ts:118) reports zero because they belong to different lanes. **Smallest fix:** retain occupancy of both lanes during a change and reject conflicting changes; check bodies during transitions.

2. **Green-light traffic yields to red-light traffic — high; confidence: high.**  
   [traffic.ts:387](src/sim/roads/traffic.ts:387) chooses merge priority without checking the other approach’s signal. In a 24-hour seed-7 run starting at 04:00, traffic on South Airport Boulevard link 3448 waits during green for vehicles held at red on feeder 1273. Vehicle 159410 remains below 0.3 m/s for **1,230.5 seconds**, exceeding the ten-minute criterion. **Smallest fix:** pass simulation time into `mergePartner` and exclude feeders still held behind a red stop line from merge priority.

3. **Train separation misses physical collisions — high; confidence: high.**  
   [trains.ts:145](src/sim/transit/trains.ts:145) ignores other routes and measures separation solely along each route. Using the committed layout and 0.5-second steps, Blue Line train bodies intersect near Rental Car Center after 107.5 seconds despite being about 1.6 km apart in route coordinates. The two BART services also meet head-on on shared track after 2,841.5 seconds. [transit.test.ts:50](test/transit.test.ts:50) checks only longitudinal gaps on loops, missing both cases. **Smallest fix:** protect shared and crossing track sections regardless of route ID or distance around a loop, and test physical train separation.

4. **Airport vehicles leave without completing their curb errand — high; confidence: high.**  
   [traffic.ts:447](src/sim/roads/traffic.ts:447) brakes only after reaching the curb lane and stops braking once the stop is more than three metres behind. For example, seed-7 vehicle 23 passes its 20.68 m stop while still crossing a four-lane departures road, then follows its outbound route without stopping. Over the 24-hour run, **1,482 drop-off and 489 pickup vehicles leave with their stop still pending**. [airport.ts:101](src/sim/roads/airport.ts:101) nevertheless counts errands when spawned. **Smallest fix:** plan the curb lane before entering the stop link, retry missed stops, and count completed service on arrival.

5. **Passengers never actually use AirTrain or BART — high; confidence: high.**  
   [terminals.ts:509](src/sim/terminal/terminals.ts:509) spawns passengers directly at the selected station; [terminals.ts:588](src/sim/terminal/terminals.ts:588) removes outbound passengers after walking there. Train door callbacks are never connected to passengers, and every train’s `load` stays zero. Freezing transit therefore does not delay these journeys. This fails “passengers use both.” **Smallest fix:** connect the existing door callbacks to boarding/alighting and make station departures wait for a train.

6. **The stuck metric permanently exempts signal approaches — high; confidence: high.**  
   [traffic.ts:485](src/sim/roads/traffic.ts:485) resets `stuck` whenever a vehicle is within 80 m of a signal, including during green. An indefinite jam there cannot fail [roads.test.ts:73](test/roads.test.ts:73). The observed 1,230.5-second wait above remained `stuck = 0`; the whole-day reported maximum was only 309.5 seconds. **Smallest fix:** include signal approaches in elapsed waiting time. Normal red phases are already far below ten minutes.

7. **The day-long road tool cannot enforce freeway throughput — medium; confidence: high.**  
   [tools/sim/roads.ts:51](tools/sim/roads.ts:51) only prints statistics; it neither measures completed freeway demand separately nor fails on acceptance violations. [roads.test.ts:67](test/roads.test.ts:67) checks final US-101 speed and total network completions. Losing over 20% of I-380 demand could pass those assertions and leave the day tool exiting successfully. **Smallest fix:** count requested and completed traffic per freeway and assert the 24-hour throughput and waiting limits.

8. **BART disappears when reversing at the airport — medium; confidence: high.**  
   [trains.ts:138](src/sim/transit/trains.ts:138) reverses direction without relocating `s` from the former front to the former rear. [carPose():186](src/sim/transit/trains.ts:186) consequently places the entire consist beyond the route endpoint and hides it. At the first airport reversal, visible cars drop from nine to zero in one step. **Smallest fix:** move the front coordinate to the former tail and reset interpolation when reversing.

9. **Road and transit tuning bypasses CONFIG — low; confidence: high.**  
   Headway, braking, signal timing, traffic demand and train acceleration are module-local constants in [traffic.ts:69](src/sim/roads/traffic.ts:69), [demand.ts:9](src/sim/roads/demand.ts:9) and [trains.ts:49](src/sim/transit/trains.ts:49). Every run therefore bypasses the required central tuning location. **Smallest fix:** move these parameters into `src/sim/config.ts`.

10. **Application warm-up writes simulation state directly — low; confidence: high.**  
    [main.ts:87](src/app/main.ts:87) directly toggles `fresh.roadsRunning` during startup and time changes, suspending both roads and transit outside a `Sim` command. This violates the requested interface boundary. **Smallest fix:** expose and invoke a simulation command for that suspension.

No findings for nondeterminism or DOM/three.js imports within the roads/transit modules.

Validation: read-only Node probes against the committed layout, including 24 simulated road hours and one transit hour. The existing traffic/transit numerical assertions passed when reproduced despite the failures above. No files changed; dependencies were not installed, and Vitest/browser rendering were not run.

<!-- end -->

### Codex (gpt-6-astra, xhigh): drawing, interface and app

<!-- report: codex-interface -->

Reviewed **b0b42a4**, limited to **Drawing, interface and app**. Eight findings:

1. **Performance sweep measures a paused airport — high; certain.**  
   [tools/visual/sweep.mjs:122](tools/visual/sweep.mjs:122) pauses before every capture. The recorded FPS therefore excludes simulation work, and no FPS threshold affects the exit status. An airport rendering at 60 FPS paused but below 20 FPS at 60× passes. **Smallest fix:** add timed, unpaused morning-peak measurements at 1920×1080 for 1× and 60×, enforcing the acceptance thresholds.

2. **Control checks accept broken picking, following and cut-away rendering — medium; certain.**  
   [tools/visual/controls.mjs:104](tools/visual/controls.mjs:104) accepts any selected aircraft, including the wrong one. Line 108 checks only the follow flag; a camera that never moves passes. Line 156 checks only the active Departures button; roofs remaining visible also passes. **Smallest fix:** assert the intended aircraft ID, actual camera tracking over movement, and visibility of the rendered roof/interior groups.

3. **Midnight operations counters count unset timestamps as movements — medium; reproduced.**  
   [src/app/ops-source.ts:32](src/app/ops-source.ts:32) tests timestamps against the reporting window without excluding the `-1` sentinel. Starting with `t=00:00&seed=7` makes that window include `-1`. A read-only reproduction produced **2,356 landings/hour and 2,356 take-offs/hour**, while the tower recorded zero of either; delays were also fabricated. **Smallest fix:** exclude unset timestamps before all three movement calculations, accounting for the negative-time warm-up.

4. **Fully extended jet bridges do not reach their aircraft — high; high confidence.**  
   [src/render/dynamic/bridge-layer.ts:60](src/render/dynamic/bridge-layer.ts:60) extends only to the fixed mapped endpoint; the aircraft supplies merely a docked/not-docked flag. In the default seed-7 08:30 state, D3’s parked B738 has its “docked” bridge tip **11.3 metres ahead of its nose and 9.8 metres sideways from its centreline**. The tunnel cannot meet the fuselage. **Smallest fix:** retain the mapped pivot but calculate the docked endpoint from the parked aircraft’s pose and door position.

5. **Clicking visible aircraft geometry can select nothing — medium; high confidence.**  
   [src/app/inspect.ts:23](src/app/inspect.ts:23) picks only within 28 pixels of a projected centre point. Zoom in and click a clearly visible nose, tail or wing outside that circle: selection clears instead of inspecting the aircraft. The point also uses the current simulation pose rather than the interpolated rendered pose. **Smallest fix:** raycast the rendered instances; an unused picking helper already exists at [aircraft-layer.ts:119](src/render/dynamic/aircraft-layer.ts:119).

6. **Fog and storm controls never change the rendered weather — medium; certain.**  
   [src/app/main.ts:143](src/app/main.ts:143) changes simulation weather, but nothing assigns `Stage.haze`, initialized to zero at [src/render/stage.ts:27](src/render/stage.ts:27). Selecting Fog reports 0.75-mile visibility while retaining clear-weather fog density, sunlight and cloud cover. **Smallest fix:** derive the stage’s weather parameters from the current simulation weather before rendering, including after time jumps.

7. **Every house is built and drawn twice — low; certain.**  
   [src/render/world.ts:78](src/render/world.ts:78) calls `buildBuildings` again for terminal roof parts. Its filter affects polygon buildings, but [src/render/static/buildings.ts:124](src/render/static/buildings.ts:124) always emits every house box. The committed layout has 6,678 houses, adding approximately 106,848 duplicate triangles plus duplicate shadow work whenever roofs are shown. **Smallest fix:** omit boxes from the roof-parts invocation.

8. **F both follows and tilts the camera — low; certain.**  
   [src/render/camera.ts:217](src/render/camera.ts:217) continuously increases tilt while F is held, while [src/app/main.ts:269](src/app/main.ts:269) uses F to toggle follow. A normal held press changes the viewing angle; keyboard repeat also toggles following repeatedly. **Smallest fix:** remove the conflicting tilt binding and ignore repeated keydowns for follow.

**Mutation invariant: no findings** in rendering/UI writes to simulation state. Weather and closure interventions use the Sim commands at [src/app/main.ts:143](src/app/main.ts:143).

Read all files in the assigned lens and ran dependency-free Node probes for counters and geometry coordinates. Build, browser tests and pixel inspection were not run; dependencies are absent and the checkout is read-only.

<!-- end -->

### Codex (gpt-6-astra, xhigh): map data, shared code, gates and records

<!-- report: codex-data -->

Found six issues in this lens.

1. **High — `npm test` omits the day-long acceptance checks.** [package.json:14](package.json:14), [test/sim.test.ts:12](test/sim.test.ts:12). Vitest selects only `test/**/*.test.ts`; the airside safety benchmark remains a separate script. Road and passenger tests cover 40 minutes and three hours respectively. A deterministic lock-up during the evening departure bank can therefore pass every required gate, contrary to AGENTS.md’s claim that `npm test` includes day-long soaks. **Smallest fix:** include the full-day acceptance checks in the required test command, with assertions and failing exit statuses. **Confidence: high.**

2. **Medium — Generated road heights make flyovers intersect.** [tools/osm/roads.ts:93](tools/osm/roads.ts:93), [public/data/roads.json:1](public/data/roads.json:1). The height solver propagates heights along connections without preserving clearance at crossings. Zero-based edges 569 and 570 cross near `(-2474.8, 1348.5)` without a shared junction: San Bruno Avenue East is at 6.5 m and the ramp at 5.59 m. The renderer’s 1.3 m deck thickness puts the ramp surface inside the bridge. **Smallest fix:** constrain the affected approach heights to preserve clearance beneath crossing decks, rebuild, and check these crossings. **Confidence: high; measured from committed coordinates and renderer code, not screenshots.**

3. **Medium — Runway-length tests validate metadata instead of geometry.** [test/layout.test.ts:40](test/layout.test.ts:40). The assertion compares `r.length` with published lengths but never measures the endpoints. In an in-memory probe, shortening every runway’s endpoint separation by 50% while retaining `length` passed all 11 layout tests. A builder regression could therefore draw half-length runways while satisfying “Real layout.” The current coordinates themselves meet the length criterion. **Smallest fix:** calculate endpoint distances and check both the published tolerance and consistency with `r.length`. **Confidence: high; reproduced.**

4. **Medium — Road connectivity ignores permitted travel direction.** [test/layout.test.ts:14](test/layout.test.ts:14). `reachable()` adds both directions for every edge, including roads with `back === 0`. A reversed terminal-loop segment can leave the network connected by this measure while preventing vehicles from completing their journeys. Making every road one-way toward increasing node IDs—eliminating every directed loop—still passed all 11 layout tests in memory. **Smallest fix:** check directed freeway-to-curb and curb-to-exit reachability using the lane directions. **Confidence: high; reproduced for the layout tests.**

5. **Medium — The binary-size gate misses unlisted formats.** [test/repo.test.ts:12](test/repo.test.ts:12). Binary classification is a filename-extension allowlist. A tracked 700 KiB `.ktx2` texture or `.mp3` receives the 1 MiB text-file limit and passes, violating the 512 KiB binary limit. **Smallest fix:** detect binary content rather than relying solely on the extension list. **Confidence: high; reproduced against the gate’s classification logic.**

6. **Medium — Partial rebuilds overwrite provenance for unchanged artifacts.** [tools/osm/build-layout.ts:65](tools/osm/build-layout.ts:65). After refreshing raw extracts, running the supported `--only airfield` rebuilds only that section but unconditionally replaces the shared provenance with the new manifest and timestamp. Roads, rail, and other unchanged files then appear to derive from sources they were never built from. The provenance test checks only digest syntax. **Smallest fix:** reject partial builds when source digests have changed unless provenance can retain the source records for unchanged sections. **Confidence: high from control flow.**

No findings on shared-code wall-clock/random/DOM isolation, or on the presence of attribution: [src/shared/sun.ts:21](src/shared/sun.ts:21), [public/data/provenance.json:3](public/data/provenance.json:3), and [src/ui/hud.ts:113](src/ui/hud.ts:113).

Validation was read-only source inspection and Node probes, including replaying the layout assertions with built-in assertions. Full npm and visual gates were not run; dependencies and Git metadata are absent from this review snapshot.

<!-- end -->

### Claude (claude-opus-5-5[1m], max)

<!-- report: claude -->

I reviewed the whole codebase at b0b42a4 against the plan's acceptance criteria and the AGENTS.md invariants. I found 7 high, 21 medium and about 34 low findings, and most lens areas came out clean except where noted. Five reviewers each read one lens, and I re-read every line cited below; findings I couldn't confirm are listed at the end.

Nothing was run. The sandbox refused `node` for me and for every reviewer, so no soak, test or probe has run. Every finding comes from reading the code and the committed data, with arithmetic where shown. Paths are relative to the repository root.

## The high findings
- **A1**: after a change of wind, departures still headed for the old runway end take off head-on into the new arrivals.
- **B1**: `npm test` runs no day-long soak, although AGENTS.md says it does.
- **P1**: all day, a few percent of departing passengers are placed straight at their gate. They skip curb, check-in and security, and their bags vanish from the books.
- **M1**: there are no connecting passengers, and the test passes without them.
- **RT1**: no road check can fail, and nothing measures freeway throughput against demand.
- **RT2**: the "stuck" measure can't see vehicles near a signal or in a creeping queue.
- **V1**: the visual sweep takes every frame-rate reading with the simulation paused, and never at the morning peak.

---

## Lens 1 — Airside: aircraft, tower, ground control, schedule, weather

### Simulation wrong or unsafe

**A1. Departures still bound for the old runway end take off head-on into arrivals on the new end** — High
- Where: `src/sim/airside/tower.ts:357-360` and `:417-418`. Both check only the time to `runway.inbound[0]`, never its direction. Also `tower.ts:183-188` (a plan change only holds back new landing slots), `tower.ts:278` (a landing excuses only a departure going its own way) and `src/sim/airside/airside.ts:25` (`CHANGEOVER` = 15 min).
- Fails:
  - A departure's runway end is fixed at pushback (`aircraft.ts:991`), and nothing changes it later.
  - Take storm, then clear. Aircraft queued or taxiing for 10L/10R keep those ends, which are the same pavements as the new arrival ends 28R/28L.
  - From about 10 minutes after the change, 28R arrivals are in `inbound`; they are added when the approach starts (`aircraft.ts:419`).
  - A 10L departure is then cleared whenever the arrival is at least about 60 s out. It climbs straight out along the centreline towards the arrival (`aircraft.ts:1064-1066`).
  - With tight timing the departure is still an occupant at the arrival's decision height, so the arrival goes around (`aircraft.ts:519-534`). The go-around climbs along the same line towards the departure (`aircraft.ts:550-558`).
  - By my arithmetic they pass head-on about 100–300 m apart vertically. West to Southeast does the same, with leftover 01L/01R departures against 19R/19L arrivals.
  - What should happen: no release towards an arrival on the opposite end.
- Fix:
  - In `mayLineUp` and `mayTakeOff`, deny when an inbound on the runway has a different `end`.
  - Hold `notBefore` for an arrival end while `departuresFor` the opposite end is above 0, so the leftover departures can clear.
- Sure: high on the code path. Nothing measures it (see B4).

**A2. Every landing jumps backwards by 3 m plus half its length at the turn-off** — Medium
- Where: `src/sim/airside/aircraft.ts:673-676`. The landing roll tracks the middle of the aircraft (`along`, set at `:668-670`). At the switch it sets `mover.s = this.body + 14 + (along − exitAlong)`, which puts the lead point at the exit node. `fuselageAt` puts the middle at `s − FRONT − L/2` (`src/sim/airfield/path.ts:221-234`). Line-up does subtract it (`aircraft.ts:816`); landing does not.
- Fails: the aircraft snaps back about 22 m (A320) to 40 m (777-300ER) on every landing, in view at 1× and in follow mode. The plan forbids moving an aircraft backwards except in a pushback.
- Fix: switch when `along + FRONT + L/2 >= exitAlong`, and set `mover.s = body + 14 + (along + FRONT + L/2 − exitAlong)`.
- Sure: high (`exit.along` is the exit node's distance along the runway, `net.ts:465`).

**A3. A push blocked by a parked neighbour counts as a way to the first runway, so the other runway is never tried** — Low–medium
- Where: `aircraft.ts:917-929` sets `leads = true` for any blocked push, whether or not it leads to `end`. Then `:1009` returns `'held'`, and `:893-900` stops trying runways after the first `'held'`. Ties in queue length go to 01L (`tower.ts:321`).
- Fails: suppose only a free push reaches 01R, and some unrelated push is blocked. The aircraft waits for 01L until the neighbour leaves or the queue lengths reorder. The stand planner (`airside.ts:246`) counts only pushes that lead to a runway, so the two disagree.
- Fix: set `leads` for a blocked push only if `leadsTo(plan.push.forward, end)`.
- Sure: high on the logic. The devlog's 15-minute longest gate hold says it was not hit badly on the benchmark seeds.

**A4. Closing a runway does not stop departures already sent to it** — Low–medium
- Where: `tower.ts:85` says "closed to new movements", but `mayLineUp` and `mayTakeOff` (`tower.ts:325-363`, `407-440`) never read `closed`.
- Fails: close 01R at 15:00 with a queue. Up to 7 queued aircraft, plus those taxiing, still line up and take off from 01R for 10–15 minutes. These departures were only assigned the runway at pushback, never cleared onto it.
- Two checks miss it: `test/weather.test.ts:66` closes the runway before anything is queued, and `tools/visual/controls.mjs:140` reads a list that is filtered by construction.
- Fix: deny line-up on a closed runway, and re-route departures still short of the hold line.
- Sure: high.

**A5. With both long runways closed, wide-bodies go to 01L/01R, and an A380 cannot lift off in the length** — Low
- Where: `tower.ts:311-317` falls back to the short runways. `aircraft.ts:1052-1058` has no length check.
- Fails:
  - An A380 needs 86 m/s at 1.7 m/s², which takes 2,175 m. Its roll starts about 97 m past the line-up node.
  - 01L is 2,345.9 m long, so it rolls off the end on the ground.
- Fix: keep wide and super aircraft on runways long enough for them, or hold them at the stand.
- Sure: high on the arithmetic. It is only reachable by closing both 28s.

**A6. The empty landing slot behind an A380 can be lost** — Low
- Where: `tower.ts:220` adds the hole at `k+1` without checking that slot is free. Slot and hole keys use the current slot length (`:228`), and `setPaired` (`:191-196`) changes that length.
- Fails: an A380 re-slotted ahead of an already-booked arrival, or a paired/unpaired change right behind an A380, leaves the follower one slot behind instead of two. Nothing measures arrival spacing.
- Fix: skip slot `k` for a super if `k+1` is taken, and key holes by time.
- Sure: medium (logic only).

**A7. Stand-ground caches ignore runway closures** — Low
- Where: `airside.ts:236` and `:284` key their caches by `plan.name`, but the pushes they store come from `departureEndsFor`, which depends on `closed` (`:239`).
- Fails: after a closure, stands are judged by stale ways out.
- Fix: add the closed set to both cache keys.
- Sure: high.

**A8. Ground tiles keep centrelines only 6.5 m apart; an A380 fuselage is 7.14 m wide** — Low
- Where: `src/sim/airfield/tiles.ts:8` and `:10-13` (`KEEP` = 3.25 m); `src/sim/fleet.ts:46` (A380 fuselage width 7.14).
- Fails: two A380s side by side at a shallow merge can overlap by about 0.6 m.
- Fix: base `KEEP` on the widest fuselage (at least 3.6 m), or on each type.
- Sure: high on the numbers; occurrence not shown.

**A9. "At most 11 departures a quarter hour" can be exceeded** — Low
- Where: `src/sim/schedule.ts:182-190`. After 12 full quarters the departure is added anyway.
- Fix: keep looking for a quarter with room, or record the overfill.
- Sure: high.

No findings:
- **Ring of waits:** none found. This follows the one-order design in `src/sim/airfield/traffic.ts:7-18`, and movement is clamped to the ground held (`aircraft.ts:741`).
- **Non-determinism:** none. Every draw comes from seeded forks (`src/sim/rng.ts:22-25`), and a search found no `Math.random`, `Date.now`, `performance` or timers in `src/sim` or `src/shared`.

### Benchmarks and tests that would pass over a defect

**B1. `npm test` runs no day-long soak, although AGENTS.md says it does** — High
- Where: `AGENTS.md:57` says "`npm test` includes the day-long soak tests". But `package.json:14` and `vite.config.ts:16` run only `test/**/*.test.ts`, and `test/sim.test.ts:12-27` runs 2 hours checking only:
  - at least 10 landings and 10 take-offs;
  - at least 85 usable gates;
  - no ground claims handed back out of order.
- Fails: fuselages meeting, runway conflicts, long waits, gate holds, overlapping stands and go-arounds all pass the gates. `tools/sim/soak.ts` is manual.
- Fix: run one seed of the soak in vitest (the plan says about 60 s), or correct AGENTS.md and the criterion's "Checked by".
- Sure: high.

**B2. "Fuselages within four metres" and "parked aircraft overlapping" are measured between zero-width lines** — Medium
- Where: `tools/sim/soak.ts:57`, `:189` and `:193-199`; `src/shared/footprint.ts:28-48` and `:82-85`. `type.fuselage` is never used by the simulation or the soak.
- Fails:
  - Two 777s at 4.1 m centre to centre pass, with their skins overlapping by 2.1 m; two A380s pass with about 3 m of overlap.
  - So a regression of the tile spacing from 6.5 m down to 4 m would get through.
  - A wingtip 2.5 m from a parked 777's centreline passes the 1 m stand test, though it is 0.6 m inside the fuselage.
  - README.md:37's "no aircraft touching" overstates what is judged; wing contact with a moving aircraft is only reported (`soak.ts:27-28`).
- Fix: subtract half the fuselage widths from the clearances, and keep reporting the old numbers.
- Sure: high on the geometry.

**B3. The wait measures miss lined-up aircraft and creeping queues** — Medium
- Where:
  - `holdOnRunway` (`aircraft.ts:1030-1047`) never sets `waitingSince`, and line-up clears it (`:814`).
  - Any step at 0.2 m/s or more resets it (`:755`, `:771-772`).
  - `stuckAtEnd` (`soak.ts:207`) counts only aircraft with `waitingSince ≥ 0`.
- Fails: a departure lined up and refused take-off for an hour passes. So does a queue that creeps a few metres every few minutes.
- Fix: count the lined-up phase as waiting, and judge the time from off-block to airborne.
- Sure: high.

**B4. The runway-conflict rule has blind spots** — Medium
- Where: `soak.ts:62-65`, `:95`, `:98`, `:102`, `:163`.
- What gets through:
  1. Only aircraft above 30 m/s are checked as the moving aircraft, but the roll-out coasts at 28 m/s (`aircraft.ts:662`). Late in its roll-out a landing is never checked, so a crossing ahead of it is never counted.
  2. Anything ahead going the same way above 50 m/s is exempt at any distance. The tower's own rule needs 1,500 m and 55 m/s (`tower.ts:278`).
  3. Airborne pairs are never counted, so A1's head-on pass is invisible.
  4. Samples are every 2 s, while an aircraft crossing a strip at speed is on it for about 1.3 s.
  5. The soak runs only the West Plan, with no plan change or closure.
- Fix:
  - Check the moving aircraft above about 10 m/s, and use the tower's 1,500 m and 55 m/s.
  - Sample runways every step.
  - Add an airborne opposite-direction check, and a run that changes the plan.
- Sure: high.

**B5. "Full cycle" is not measured per flight, and the denominator is 589, not 600** — Low
- Where: `soak.ts:205-206` and `:230-231` count landings and take-offs separately over 26 hours. The schedule makes 589 visits (rounding of airline shares, `schedule.ts:208-209`), while the plan's done-condition says the configured 600.
- Fails: overnight departures and next-morning movements in the window can make up for missing ones.
- Fix: judge each visit due in one 24-hour span on whether it landed, parked and took off.
- Sure: high on the direction; I didn't count the size of the effect.

**B6. The weather tests and the scenario tool are not specific** — Low
- Where:
  - `test/weather.test.ts:58-59` passes on any delayed arrival, with no clear-weather baseline.
  - The storm test (`:36-42`) checks only after 30 minutes, so the transition where A1 happens is never checked.
  - `tools/sim/scenario.ts:134` fails only on ground meetings, waits and gate holds.
- Sure: high.

**B7. "At least 85 numbered gates in use" counts gates that could be used, not gates used** — Low
- Where: `soak.ts:208`; `test/sim.test.ts:20-23`.
- Sure: high.

### Invariants
**I1. Dead config and safety numbers kept outside config.ts** — Low
- `config.ts:61` (`retry`) and `:63` (`maxGateHold: 900`, "longest a departure is held at its stand") are never read, so the promised 15-minute cap is not enforced.
- Separation numbers are hard-coded in `tower.ts`: lines 22-28, 278 (1,500 m and 55 m/s), 353 (600 m), 412 (1,700 m) and 469 (90 m). The soak restates them differently (50 and 30 m/s).
- The landing-roll model is written twice: `aircraft.ts:147-157` and `:659-666`.
- `BESIDE = 2` (`airside.ts:21`) differs from `STAND_CLEARANCE = 3` (`footprint.ts:14`).
- Sure: high.

### Visual
- See A2. Nothing else in these files.

---

## Lens 2 — People, queues and bags in the terminals

### Simulation wrong

**P1. All day, late domestic passengers are placed straight at their gate, and their bags vanish** — High
- Where: `src/sim/terminal/terminals.ts:427` passes `now − p.at` as "late". Its mid-day-start branches are at `:489-507`.
- Fails:
  - `spawnDue` runs every 0.5 s step, so in normal running `late` is between 0 and 0.5 s, which is above zero.
  - So `sinceStart > 0 && now > boardingAt − 1800` fires for any party arriving less than boarding time plus 30 minutes before departure.
  - With the domestic lead time drawn from N(6300 s, 1500 s), clamped at 3,000 s (`:404`; clamped parties get exactly 0), that is about 1.6% of regional, 4.5% of narrow-body and 14.5% of domestic wide-body parties.
  - These parties never use a curb, check-in desk or checkpoint. `addParty` zeroes their bags (`:530`), so those bags are never counted.
  - These are the parties most likely to miss their flight, so the missed-flight figure and the security load are both understated.
- Fix: store the start time, and pass `p.at < startTime ? now − p.at : 0`.
- Sure: high (the shares follow from the clamp).

**P2. A desk keeps the id of a party sent away while being served; when the id is reused, the simulation can crash** — Medium
- Where:
  - `src/sim/terminal/queue.ts:95-99`: `leave` doesn't clear `server.serving`.
  - `src/sim/terminal/people.ts:209-212` (`setScript`) and `:166` (ids reused last-in-first-out).
  - `people.ts:411`: the finish check passes for the id's new owner.
  - `people.ts:396` overwrites the new owner's `tx` with its spot in line; `people.ts:338-340` then uses `tx` as a distance-field index.
- Fails:
  1. Doors close while a party is at a check-in desk (`terminals.ts:861`; service takes up to about 200 s, `:817`).
  2. The party walks out and is removed. A new party gets its id and joins the same hall's line.
  3. When the desk's timer ends, the new party is advanced past its queue step while still in `line`.
  4. Each step, its spot in line (x ≈ −750 to −1,270 m in the check-in halls) is written into `tx`. `walk()` reads `fields[-1050]`, which is undefined, and throws a TypeError that stops the whole simulation.
  5. If instead it was at the head of the line, it is called to a desk and stands there for ever, ending as "missed".
- Fix: in `ServiceQueue.leave`, also do `for (const s of this.servers) if (s.serving === person) s.serving = -1;`.
- Sure: high on each link; I didn't measure how often it happens (it needs a missed party at a desk).

**P3. Checkpoint lanes are built for two-thirds of their busiest hour** — Medium
- Where: `terminals.ts:300-310`. The book holds days −1 and 0 (`src/sim/airside/flights.ts:71-105`), but `days` counts distinct `floor(std/86400)`.
- Fails:
  - After-midnight and overnight departures (`schedule.ts:24-25`, `:225`) push some `std` values into a third day, so the busiest hour is divided by 3, not 2.
  - Lanes come out as ceil(peak/180) instead of peak/150 × 1.25.
  - A lane serves about 157 people an hour (`:814`, mean party 1.73), so above the 8-lane floor capacity is about 87% of the busiest hour.
  - Starting at 16:00 or later the factor becomes 3/4, so the lane count depends on the start time.
- Fix: count days as distinct `floor(v.id / 100000)`.
- Sure: high on the arithmetic; I didn't measure the effect on waits.

**P4. A gate change reaches only parties standing still when boarding opens** — Low
- Where: `terminals.ts:836-843` re-scripts only parties in `ACT.wait` more than 40 m from the new gate. The way to the gate is fixed after security (`:548`).
- Fails:
  - Parties walking at that moment board through the old gate.
  - A change between D and E (not joined after security) makes re-scripted parties walk straight through walls (`people.ts:344-351`).
- Fix: at boarding, re-script any party whose way doesn't end at the visit's current gate.
- Sure: high.

**P5. Cancellations leave bags counted as loaded, and some passengers counted as boarded** — Low
- Where: `terminals.ts:847-850` cancels a flight. Bag outcomes were already decided at the desk (`:779-783`).
- Fails: at a start, an aircraft that fails to fit its stand is discarded (`airside.ts:132-133`). If its arrival was more than an hour before the start, the visit is never flown (`airside.ts:359`), but its passengers were counted on board (`terminals.ts:493-498`).
- Fix: at cancellation, move the flight's checked bags to a returned count, and don't count boarding for a visit with no aircraft.
- Sure: high; the case is rare.

**P6. Staff partly ignore the time of day** — Low
- Cleaners are only ever added (`terminals.ts:935-947`), so 36 stay all night instead of 14.
- A post keeps the same person for as long as it is open, with no shift change (`:912-924`), though the criterion says staff "change with the shift".
- Shops take money at any hour (`:691-699`), while shop staff are posted only 05:00–23:30 (`:906`).
- Sure: high.

No findings:
- **Lock-ups:** doors always close by departure minus 120 s (`terminals.ts:856`).
- **Stranded queues:**
  - Nobody is left in a line with no server; at least one lane stays open while anyone is in line (`terminals.ts:882-887`).
  - A closing server finishes its customer (`queue.ts:137-142`).
- **Checkpoint closure:** closing is refused when an area would have no way through, and reopening rebuilds the diversions (`terminals.ts:441-476`).
- **Determinism:** ties in the pending sort are broken by visit (`:413`).
- **Cost at 40,000 people:** linear per step (`people.ts:239-272`, `386-418`).

### Benchmarks and tests that would pass over a defect

**M1. There are no connecting passengers, and the test can't see it** — High
- Where: the airlines' `connecting` shares (`src/sim/fleet.ts:136-137`; 0.3 for United) are never read. Departing parties come only from landside (`terminals.ts:509-521`), and arriving parties only leave (`:664-678`).
- Fails: the criterion and the plan's scope both name connecting passengers. `test/people.test.ts:21-26` passes with none.
- Fix: route a share of arriving parties to a later departure's gate, and test that they are counted.
- Sure: high.

**M2. The bag balance can't fail, and the mishandled figure is mostly two constants** — Medium
- Where:
  - `people.test.ts:41` checks `loaded + leftBehind + misrouted <= checked`. That holds by construction: `terminals.ts:779-783` and `:496-497` add each bag to `checked` and to exactly one outcome.
  - A bag's outcome is fixed at the desk, so a bag whose owner then misses the flight, or whose flight is cancelled, stays "loaded".
  - Arriving bags have no created count (`:649-651`).
  - P1's bags vanish.
- The reported share (`src/app/ops-source.ts:72`) is a 0.2% misroute draw (`:782`), a 0.3% loss draw (`:660`) and a timing rule (`:781`).
- Bags don't move through sorting, carts or carousels as the scope describes; the bag system is a list of (time, count) pairs (`:111-112`).
- Fix: count bags when they are created, in both directions; check created equals outcomes plus those still in the system; settle a party's bags when its flight's doors close.
- Sure: high.

**M3. The tested window is mostly start-up, stuck people count as present, and the full day is never gated** — Medium
- Where:
  - `people.test.ts:15-16` runs 05:00–08:00. At the start, the rules at `terminals.ts:502` place most of the 06:00 wave at their gates, and put everyone due 04:20–05:00 at the curbs at once.
  - The balance (`people.test.ts:24-25`) counts a walker stuck for hours as present.
  - `tools/sim/people.ts:71-77` prints the balance but has no limits and no exit code.
  - Arrivals that could not be created are counted as left (`terminals.ts:645-647`).
- Fix:
  - Gate a full day, with limits and an exit code.
  - Bound the age of any walker whose flight's doors have closed.
  - Measure only flights leaving more than about 4.5 hours after the start.
- Sure: high.

**M4. The security 95th percentile counts only people already served** — Medium
- Where: `terminals.ts:762-770` records a wait when a person reaches a lane, and `percentile` (`:63-72`) uses only those. The panel's `recentWait` (`queue.ts:160-163`) does the same, and it freezes when a checkpoint closes.
- Fails: a line still growing at the end of the window never counts.
- Fix: also count now minus join time for everyone still in line (`queue.ts:40`).
- Sure: high.

**M5. Floor-plan reachability is only partly tested, and gaps show up as people walking through walls** — Low
- Where: `test/terminal-plan.test.ts:15-23` checks only exit to gate, and skips areas with no exit. Nothing checks curb or station to check-in to checkpoint, or checkpoint to airside. `people.ts:344-351` walks straight for the goal when it is unreachable.
- Fix: assert those ways are reachable, and fail on any straight-line fallback.
- Sure: high for the test gap; I don't know whether such gaps exist.

**M6. Determinism with people is tested for one hour only** — Low
- Where: `people.test.ts:99-107`. The six-hour test, which is the one the criterion names, runs the airside alone (`test/sim.test.ts:31-38`).
- Sure: high.

### Invariants
- Low: the numbers that decide the acceptance results are hard-coded in `terminals.ts`, not `config.ts`. Examples are lines 25-31, 233, 237, 243, 404-406, 649-660, 780-782, 814-821, 847, 856 and 871-883.
- No three.js or DOM imports and no `Math.random` (`terminals.ts:12-20`): no findings.

### Visual
- No findings in these files.

---

## Lens 3 — Roads and transit

### Simulation wrong

**R1. Merge priority ignores signals, so a car with a green yields to one held at a red** — Medium
- Where: `src/sim/roads/traffic.ts:375-406` (`mergePartner`) never calls `green()`. It is applied at `:435-436`; the phases are set at `:299-302`.
- Fails:
  - Take two approaches on different phases feeding one exit lane. The red approach's front car waits about 3.7 m from the line (`:352`).
  - The green approach's front car treats that car as the one to follow and stops about 10 m out, on a green.
  - When the phases swap, the same happens the other way. So about one car per phase gets through.
- Fix: in `mergePartner`, skip a partner whose own link is signalled and red (pass `now` in).
- Sure: high on the mechanism; I didn't count how many signalled junctions have this shape.

**R2. Curb errands can drive past their stop, and are counted as done when they spawn** — Medium
- Where:
  - `src/sim/roads/airport.ts:101-102` counts drop-offs and pick-ups at spawn.
  - `traffic.ts:276` forces the curb lane only on the curb link itself.
  - A stop is taken only in the rightmost lane, within 22 m of the stop point (`:447-450`, `:492`).
  - Lane changes come at least 2.6 s apart (`:630`).
  - A missed turn reroutes to the final exit, dropping the stop (`:551-558`, `:160`).
- Fails: a car entering a short four-lane Departures link in its left lane often passes its stop. It still counts as a drop-off.
- Fix:
  - Force the curb lane from the link before the curb.
  - Route through the curb link after a missed turn.
  - Count errands served and skipped.
- Sure: high on the mechanism; I didn't measure the share.

**R3. The AirTrain Blue Line folds through itself at Long Term Parking** — Medium
- Where: `src/sim/transit/routes.ts:252` makes Long Term Parking the turning point. `routes.ts:108-109` lets a path leave a stop backwards. Trains on a loop always run forward, with cars trailing behind the front (`src/sim/transit/trains.ts:186`).
- Fails:
  - The data shows Long Term Parking's stopping points, (−2228.3, 1793.6) and (−2242.5, 1787.8), are on stub tracks. Their dead ends, (−2233.7, 1805.1) and (−2247.7, 1798.5), each appear once in `rail.json`.
  - So after leaving, the front car runs back down the track the rear cars are still on, and the cars overlap facing opposite ways for one train length.
- Fix: mark reversal stops when the route is built, and at doors-close there move the train forward by its own length.
- Sure: high for Long Term Parking. The reviewer's similar claim for Garage G & BART I couldn't verify.

**R4. BART vanishes at the airport station when it leaves** — Medium
- Where: `trains.ts:137-141` flips only `direction`; the stop is at the route end minus 1 m (`routes.ts:273`). The cars are then drawn past the route end (`trains.ts:186`), where they are hidden (`:188`).
- Fails: all 9 cars disappear when the doors close, then grow back one by one over about 20 s.
- Fix: on the flip, move `s` (and `ps`) back by the train's length (cars × car length).
- Sure: high.

**R5. Trains are kept apart only from trains on their own route** — Low
- Where: `trains.ts:146` skips other routes, but BART's two routes share the track from the tunnel portal (`routes.ts:262-275`). `trains.ts:149` also ignores a train that already overlaps within 25 m.
- Fix: check trains on shared track by position.
- Sure: high on the code; meetings not measured.

**R6. Crossing traffic at junctions passes straight through** — Low–medium
- Where: vehicles on different links interact only at merges (`mergePartner`) and through the next link's last car (`beyond`, `traffic.ts:349-369`).
- Fails:
  - Opposed left turns go on the same green as oncoming traffic (`:299-302`).
  - Unsignalled crossings have no rule at all.
  - `overlaps()` (`:118-132`) compares cars in one lane of one link only, so the test can't see any of this.
- Fix: a yield rule between links inside a junction, and an overlap check across them.
- Sure: high on the code; I didn't measure how often it shows.

**R7. A start before 00:07 runs the road and train clock negative** — Low
- Where: `src/app/main.ts:80-90` starts the simulation 30 minutes early, so `t=00:00` begins at −1800 s. "Negative means unset" is used at `traffic.ts:422`, `:495` and `trains.ts:131`, `:163`, and the signal phase `(now + junction*17) % 64` goes negative (`traffic.ts:300`).
- Fails: curb cars and trains re-arrive every step and are held at their stops until the clock passes 0, and phase-1 signals stay red meanwhile.
- Fix: keep the clock at or above 0, for example by adding a day.
- Sure: high.

**R8. A three-way merge can deadlock** — Low
- Where: `traffic.ts:399` treats cars within 0.5 m as tied, which makes "ahead" non-transitive.
- Fails: take three front cars 1.0, 0.6 and 0.2 m from their link ends, on equally fast roads, with ids rising in that order. Car a yields to c (strictly nearer), c yields to b and b yields to a (both by the tie-break on id). All three stop, and nothing changes after that.
- Fix: compare a strict order (rounded distance, then id).
- Sure: the logic is certain; not shown to happen.

Checked, no defect:
- **Vehicle count:** every removal is counted (`traffic.ts:524-530`).
- **Signals:** they always cycle (apart from R7).
- **Loops:** loop trains wrap correctly (`trains.ts:116-120`, `:156`).

### Benchmarks and tests that would pass over a defect

**RT1. No road check that can fail; demand and throughput are never measured** — High
- Where: `tools/sim/roads.ts:21` and `:24` default to 3 hours from 07:00, and it only prints, with no exit code.
- Fails:
  - When an entry is blocked, `spawn` returns null (`traffic.ts:204`). Unmet demand is carried silently, up to 40 vehicles per entry; only the excess counts as backlog (`demand.ts:109-116`).
  - `test/roads.test.ts:3` says "the soak test covers a day", but `tools/sim/soak.ts:150` builds a Sim without roads.
  - The criterion (no vehicle stuck over 10 minutes, freeway throughput within 20% of demand) is therefore never checked.
- Fix:
  - Count vehicles asked for and entered, per entry; count exits per freeway.
  - Run 24 hours with both limits and an exit code, as a named gate.
- Sure: high.

**RT2. The stuck measure can't see a jam at a signal or a creeping queue** — High
- Where: `traffic.ts:485-486` resets the counter for any car within 80 m of a signalled link end, whatever the light, and for any speed of 0.3 m/s or more.
- Fails: a red lasts 36 s, yet a gridlocked signal never registers. A queue moving one car length per 64 s cycle reports under a minute. This is exactly where R1's queues form.
- Fix: drop the exemption, and measure the time since a car last moved about 10 m.
- Sure: high.

**RT3. `test/roads.test.ts` can't catch a throughput shortfall, curbs not being reached, or a car failing to brake** — Medium
- Where:
  - `roads.test.ts:70` asks for at least 5,000 vehicles finished in 40 minutes, a fixed floor not compared with demand.
  - The curb and garage figures (`:83-85`) are spawn counts, and `curbStops` (`:86`) is a snapshot.
  - Overlaps are sampled every 20 steps, within one lane (`:62`).
  - The movement clamp (`traffic.ts:470-471`) stops a car instantly, so a car that failed to brake never shows as an overlap.
- Fix: compare vehicles entered with those asked for, count curb arrivals, and check braking limits.
- Sure: high.

**RT4. "Passengers use both" AirTrain and BART: no mechanism and no test** — Medium
- Where: a train's `load` is never written (search). The door events are used only by the transit test. The terminals create and remove people at stations whatever the trains do (`terminals.ts:45-46`, `:509-513`, `:588-590`).
- Fix: tie rail arrivals and departures to the doors opening at the station, and test counts per line.
- Sure: high.

**RT5. The transit checks are narrow** — Low
- Where:
  - `test/transit.test.ts:50-59` checks spacing within a loop route only, which can't see R3–R5.
  - `Sim.checksum` leaves transit out (`src/sim/sim.ts:117`), though `sim.test.ts:40` is named "roads and trains included".
- Sure: high.

### Invariants
- Low: none of the roads or transit numbers are in `config.ts`. Examples: `demand.ts:9-12`, `airport.ts:14`, `traffic.ts:69-80` and `:485-486`, `routes.ts:242-302`.
- No `Math.random`, wall clock or DOM: no findings.

### Visual
- See R3, R4 and R6.

---

## Lens 4 — Drawing, interface and app

### Simulation wrong or written from the app
- **Stepping:** no findings. The simulation advances in whole fixed steps, and commands run between them (`src/app/main.ts:312-320`). A jump rebuilds the Sim and re-applies weather, closed runways and closed checkpoints (`:82-92`, `:229-237`).
- Low: `window.advanceTime(10000)` at 60× advances 120 s, not 600, because of the 240-step cap and the clamp on the remainder (`main.ts:315-317`, `:383-388`). No tool uses it yet.
- Low: the jump ignores a refusal when re-closing checkpoints (`main.ts:85`), so the viewer's record and the simulation could disagree.

### Checks and tools that would pass over a defect

**V1. The sweep can't measure "Fast enough"** — High
- Where:
  - `tools/visual/sweep.mjs:121-122` pauses after every jump, so every frame rate it reads is with the simulation stopped.
  - It never visits the morning peak: the jumps are 06:45, 12:30, 19:00 and 22:30 (`src/ui/hud.ts:10-13`), and the default visits day, dusk and night (`sweep.mjs:38`).
  - It captures at 2560×1440 (`:37`), but the criterion is 1920×1080.
  - `slowestFps` is written to the manifest (`:163-165`) but never compared with 45 or 20.
- Fails: a 60× step costing 15 ms a frame would still read about 60 fps.
- Fix: load `t=08:30` at 1920×1080, count frames for about 10 s at 1× and at 60×, and fail below 45 and 20.
- Sure: high.

**V2. Pan, orbit, zoom, presets, number keys, `[` `]` and H are never checked** — Medium
- Where: there is no check for them in `tools/visual/controls.mjs:64-164`. The sweep drives the mouse (`sweep.mjs:125-159`) but asserts nothing. `README.md:40` says the tool "checks every control does what it says".
- Fix: compare the camera view before and after each input, including the direction of change.
- Sure: high.

**V3. Several `controls.mjs` checks can't fail on what they name** — Medium

| Line | Check | Why it can't fail |
|---|---|---|
| `:86` | Board opens with rows | 16 rows always exist (`src/ui/board.ts:19`, `:44-51`); empty ones are only hidden (`:64`). |
| `:104` | Clicking an aircraft | Never compares the picked id with the one aimed at. |
| `:121` | A board row picks and follows | Any followed aircraft passes. |
| `:161-164` | A jump keeps the closed checkpoints | 3 closed is true of the old simulation if the jump did nothing; the clock is never checked. |
| `:140` | Closing 01R stops departures | Reads a list filtered by construction, so it misses A4. |

- Sure: high.

**V4. The load step never checks that traffic is moving** — Low
- Where: `sweep.mjs:94-101` checks only that the page is ready and on the GPU. The "Runs" criterion asks for traffic already moving in the first frame.
- No capture covers the arrivals cut-away, the boards, the inspector, or any weather other than clear.
- Sure: high.

### Render or interface writing simulation state
- Render and interface: no findings. The panel sorts its own copies (`ops-source.ts:69`, `:94`), and the boards build new arrays (`flights.ts:125-176`).
- Low, grey area: the app writes `fresh.roadsRunning` outside the three commands (`main.ts:87-89`). A warm-up method on Sim would remove this.

### Visual and interactive

**D1. Weather never reaches the picture** — Medium
- Where: `src/render/stage.ts:26-27` declares `haze = 0`, which drives the fog, sun, clouds and stars (`:132-172`). Nothing assigns it (search).
- Fails: fog, low cloud and storm change the runways and the panel, but the sky stays clear.
- Fix: set `stage.haze` from the simulation's weather in `drawFrame`.
- Sure: high.

**D2. Ground paint likely draws over the arrivals cut-away floor, and over cars seen from far off** — Medium
- Where:
  - Painted ground (`src/render/static/common.ts:61-78`) is drawn after every solid, without writing depth, and pulled towards the camera by twice its depth slope.
  - The ground cover is painted this way and covers the whole airport with no holes (`src/render/static/ground.ts:73-80`, `tools/osm/land.ts:117-118`), so it lies under the terminals.
- Fails:
  - A solid less than about 2·D·α·cos(elevation) above the paint loses, where D is the camera distance and α ≈ 42°/1080 px (`stage.ts:56`).
  - The arrivals floor is at 0.55 m (`src/render/static/interiors.ts:80`, `src/sim/terminal/plan.ts:18`), so it loses beyond about 570 m at a 45° view.
  - A true-size car on a painted road loses beyond about 1.5 km.
- Fix: draw the ground cover before the solids, or cut the terminal footprints out of it.
- Sure: medium. The mechanism and arithmetic are from the code; it has not been rendered, and no capture shows the arrivals level. To confirm: `probe.mjs` at 1920×1080 with `inside=arrivals&view=terminals`.

**D3. Clicking an aircraft only works within 28 px of its middle** — Medium
- Where: `src/app/inspect.ts:12` and `:23-32`; the comment at `:27` says "anywhere along their body".
- Fails: up close, a click on the nose, a wing or the tail picks nothing or a neighbour. A miss closes the card and ends follow (`main.ts:193-197`, `:222-225`).
- Fix: use the unused instanced raycast pick at `src/render/dynamic/aircraft-layer.ts:118-130`, with bounding spheres recomputed first.
- Sure: high.

**D4. The departures cut-away likely draws rooms from every floor on one plane** — Low–medium
- Where: `interiors.ts:84-88` ignores each room's level.
- Fails: `terminals.json` has check-in, food, shop and toilets on levels 0, 1 and 2, so rooms stacked in plan will flicker against each other.
- Sure: high on the code; I didn't check which rooms overlap in plan.

**D5. Smaller interface defects** — Low; sure for each
- Bags on the belts can count a claim hall twice when two areas share it (`ops-source.ts:70`; areas without a hall fall back to the nearest, `plan.ts:314-318`).
- With a start before 00:30, landings and take-offs per hour count every flight not yet landed, until 01:00 (`ops-source.ts:24`, `:32`, `:36-37`).
- The main gear sinks about 0.4 m at rotation, because the model pitches about its middle while the simulation's altitude is still 0 (`aircraft-layer.ts:78-81`, `aircraft.ts:1054`).
- F both tilts the camera and toggles follow (`src/render/camera.ts:217`, `main.ts:269-270`). Key repeat isn't ignored (`main.ts:246-274`).
- `[` at 1× pauses (`hud.ts:7`), though README.md:21 lists speeds 1–60.
- "That flight has no aircraft here yet" is shown in the operations panel, which may be closed (`main.ts:208`).
- In the arrivals cut-away, every walker is scanned once per claim hall each frame (`interiors.ts:163-164`, `terminals.ts:985-993`).

No findings:
- **Instance counts:** they are reset every frame, and extra instances are dropped safely (`vehicle-layer.ts:40`, `:46`; `aircraft-layer.ts:64`, `:68`).
- **Memory:** event lists are capped (`airside.ts:162`, `terminals.ts:480`), and board rows are reused.

---

## Lens 5 — Map data, shared code, gates and records

### Data and shared code
- **Real layout:** the committed data meets the criterion. Runway lengths in `public/data/airfield.json` are 2,345.9, 2,635.9, 3,614.9 and 3,461.5 m (+0.60%, 0.00%, −0.09% and −0.22% from the published figures). The test checks hard-coded published figures, so it can fail (`test/layout.test.ts:12`, `:37-43`).
- Footprint clearances: see B2.
- Low: `lengthForSpan` makes some aircraft too short (`src/shared/footprint.ts:19-24`; a 65 m span gives 70.2 m against the 777-300ER's 73.9 m). The simulation re-checks with real outlines.
- Low: `localeCompare` without a locale in the simulation (`tower.ts:321`, `schedule.ts:126`) makes order depend on the runtime's locale. A browser in another locale could build a different day from Node. Compare with `<` or pass `'en'`.

### Gates and tests

**G1. The taxiway test doesn't check letters** — Low–medium
- Where: `layout.test.ts:86` asks for at least 40 distinct taxiway names.
- Fails: it still passes if taxiways A and B vanish.
- Fix: assert the lettered set is present.
- Sure: high.

**G2. "Contact gate" is trusted from a ref match** — Low
- Where: `tools/osm/airfield.ts:254-258` marks a stand as contact if any gate node anywhere has the same ref. There is no distance or jet-bridge check, and `layout.test.ts:57-63` trusts the flag.
- Sure: high.

**G3. The file-size gate checks only staged files, and spots binaries by extension** — Low
- Where: `test/repo.test.ts:11` lists only staged files. `:12` recognises binaries by a fixed list of extensions, so a `.hdr`, `.ktx2` or `.wav` between 512 KiB and 1 MiB is treated as text.
- Without git, as in this copy, the test fails loudly rather than passing silently.
- Fix: add `--others --exclude-standard`, and detect binaries by content.
- Sure: high.

**G4. The boundary patterns miss some forms** — Low
- Where: `repo.test.ts:41-46` misses `import 'three'`, `import('three')`, `setTimeout`, `crypto` and `Date()`.
- Sure: high.

B1 belongs here too: AGENTS.md misstates `npm test`.

### Invariants
- No findings. A search of `src/sim` and `src/shared` for `Math.random`, `Date.now`, `new Date`, `performance.`, timers, `crypto`, `window.`, `document.` and three.js found only a comment (`tower.ts:3`).

### Records
Low; sure for each.
- `AGENTS.md:57` (B1); `README.md:37` "no aircraft touching" (B2).
- The plan says 600 visits a day (`plan.md:83`, `:117`); the code builds 589.
- `src/shared/geo.ts:2` says "accurate to centimetres", but it uses a 6,371 km sphere (`:7`), which is about 0.2% off WGS84 at SFO, or about 12 m over the map. The runway lengths still pass.
- `config.ts:62-63` promises a 15-minute gate-hold cap that nothing enforces.
- The OSM attribution is plain text and hides with the rest of the HUD (`hud.ts:113`, `main.ts:244`). The README and `provenance.json` carry it correctly.
- `reviews/` doesn't exist yet. That criterion is still open in M6, so this isn't a false claim.

---

## Dropped, and not done
- **Dropped:**
  - A road overlap when a car at a link end is pulled back (`traffic.ts:466-473`, `:535-541`): the code path exists, but I couldn't show a car overshooting into a blocked link.
  - The reviewer's claims about full-buffer uploads per frame, follow ending in the sky, the provenance timestamp and 103 of 104 jet bridges: I didn't re-read those lines.
  - The Garage G & BART fold: not verified.
- **Not done:**
  - No soak, test, build or visual sweep was run, because the sandbox refused `node`.
  - No capture was looked at.
  - The held-out seeds were not run.

To turn the likely findings into evidence, these runs would confirm them:
- A1: `node tools/sim/scenario.ts --start 10:00 --hours 3 --weather storm@10:30 --weather clear@11:30`, logging 10L/10R take-offs against the direction of the next inbound.
- P2: a people run with a checkpoint closed.
- D2: the `probe.mjs` capture of the arrivals cut-away.

<!-- end -->

## Findings and disposition

IDs are by lane and lens in the order reported: Codex airside F1–F9, people F10–F19, roads F20–F29, interface F30–F37, data F38–F43; Claude F44–F100; and, from the inspection of the 72 captures of the visual sweep at `b0b42a4` (by a subagent looking at every capture at full resolution, not a runbook lane), F101–F112. Where two lanes report one defect the later row points to the earlier. "Fixed" names the commit and the check that would fail if the defect came back.

| ID | Finding | Disposition and reason | Repair or follow-up |
|---|---|---|---|
| F1 | A closed runway still clears departures already sent to it (high) | Not changed, by design: a closure takes no new traffic, and aircraft already on their way to it still use it, as the event log and README say. Sending a taxiing departure to another runway means re-planning its claimed route in the ground order mid-journey, which the ground model does not do; holding it at the hold line would block the taxiway behind it until the runway opened. | Follow-up proposed: re-plan a taxiing departure to another runway. |
| F2 | An arrival six hours late dropped out of the schedule for good | Fixed | b2f9468: waited for until it lands |
| F3 | A super-heavy's slot could leave a taken slot behind it | Fixed | b2f9468 |
| F4 | A change of visibility left ghost reservations | Fixed | b2f9468: slots and gaps keyed by time |
| F5 | The soak did not count whole cycles | Fixed | b2f9468: cohort counted visit by visit |
| F6 | The runway-conflict measure excused a landing ahead | Fixed | b2f9468, then cf018f0 (see F56) |
| F7 | `npm test` ran no day-long airside run | Fixed | b2f9468: `test/soak.test.ts` |
| F8 | Tuning numbers outside `config.ts` (traffic, weather, schedule) | Partly fixed: tower, slot, schedule and weather tuning (b2f9468) and the runway separation numbers (a8cc5ed) are in `CONFIG`. About 70 numbers in the ground traffic, roads, trains and terminals remain in their modules. | Follow-up proposed: move the rest into `CONFIG`, checked by unchanged checksums. |
| F9 | Aircraft jumped about 15 m back at the turn-off | Fixed | b2f9468 |
| F10 | Passengers boarded at a gate their flight had left | Fixed | 67314e9: boarding checks the gate |
| F11 | A mid-day start dropped bags | Fixed | 67314e9 |
| F12 | A cancelled flight kept its bags as loaded | Fixed | 67314e9 |
| F13 | A reused person id could be stranded at a desk | Fixed | 67314e9 |
| F14 | No connecting passengers | Fixed | db17828 |
| F15 | The floor plan dropped the BART entrance | Fixed | a22e0a0; `test/terminal-plan.test.ts` |
| F16 | A full walker list lost departing passengers | Fixed | 67314e9: they board unseen and are counted |
| F17 | The people day could not fail | Fixed | 67314e9: checks and exit 1; 07092f9: in `npm test` |
| F18 | The bag test let bags disappear | Fixed | 67314e9: exact conservation both ways |
| F19 | Terminal tuning outside `config.ts` | Deferred with F8 | F8's follow-up |
| F20 | Lane changes let cars pass through each other | Fixed | be4f0c8; `overlaps()` counts across lanes in `test/roads.test.ts` |
| F21 | Traffic on a green yielded to traffic held at red | Fixed | be4f0c8 |
| F22 | Trains on shared track could meet | Fixed | da0c779: blocks; d95ad5c: tracks closer than a train is wide; `test/transit.test.ts` looks for trains inside each other by their drawn bodies |
| F23 | Curb errands counted when they set out, and some never stopped | Fixed | be4f0c8: lane planned before the curb, retry, counted on arrival |
| F24 | Passengers never rode AirTrain or BART | Fixed | e37798e; `test/people.test.ts` 'people and the trains' |
| F25 | The stuck measure could not see a signal | Fixed | be4f0c8 |
| F26 | The road day judged nothing | Fixed | be4f0c8, 07092f9: exit 1, in `npm test` (`test/day.test.ts`) |
| F27 | BART vanished as it turned round | Fixed | da0c779; `test/transit.test.ts` |
| F28 | Road and train tuning outside `config.ts` | Deferred with F8 | F8's follow-up |
| F29 | The app's warm-up wrote simulation state | Fixed | e37798e: `Sim.warmUp` |
| F30 | The sweep measured frame rates paused | Fixed | d4e693d: running at 1× and 60× at 08:00, 1920×1080, fails below 45 and 20 |
| F31 | Control checks that could not fail | Fixed | d4e693d, bc37022 |
| F32 | A day opened at midnight counted unset times as movements | Fixed | da0c779: `NOT_YET`; `test/ops-source.test.ts` fails with the old -1 |
| F33 | Jet bridges did not reach the aircraft | Fixed | d4e693d: swing to the forward door |
| F34 | Clicking picked only near an aircraft's middle | Fixed | d4e693d: ray against the drawn aircraft; controls check clicks a wing 80 px out |
| F35 | Weather never reached the picture | Fixed | d4e693d; controls check reads the haze in fog |
| F36 | Houses built twice | Fixed | d4e693d |
| F37 | F both tilted and followed | Fixed | d4e693d |
| F38 | `npm test` omitted the day-long checks | Fixed | b2f9468, 07092f9 |
| F39 | Flyovers inside the bridges over them | Fixed | da0c779: clearance in the height solver; too-close crossings roads 24 to 4, rail 18 to 0; the 4 left are at the US-101/I-380 interchange, whose mapped layers leave no room, allowed by name in `test/layout.test.ts` |
| F40 | Runway lengths checked from the recorded number | Fixed | da0c779: measured between the ends |
| F41 | Road connectivity ignored one-way roads | Fixed | da0c779 |
| F42 | The size gate judged binaries by name only | Fixed | d95ad5c: by content too, and new files |
| F43 | A partial rebuild rewrote provenance for files it did not build | Fixed | 07092f9: refused when the extract changed |
| F44 | After a wind change, departures took off head-on into arrivals (high) | Fixed | d95ad5c: not released towards an arrival coming the other way; no slot while departures are on their way to the other end; the scenario tool fails on aircraft flying at each other: one on seed 7's storm and back before, none after, nor in four more scenarios |
| F45 | Landings jumped back at the turn-off | = F9 | |
| F46 | A blocked push counted as a way to the first runway | Fixed in its logic | 879fb1a: counted only if it leads there. The 11 seeds give the same checksums as before, so the case did not arise there; no test makes it arise. |
| F47 | Closing a runway did not stop departures sent to it | = F1 | |
| F48 | With both long runways closed, wide bodies went to a runway too short | Fixed | d95ad5c: only runways long enough, or wait |
| F49 | The gap behind an A380 could be lost | = F3 | |
| F50 | Stand caches did not know closed runways | Fixed | d95ad5c |
| F51 | Ground tiles keep centrelines 6.5 m apart, under an A380's width | Noted: the soak now judges fuselages touching at their width and finds none on 11 seeds. Widening the tiles for the widest aircraft would cost room everywhere. | |
| F52 | The departures-per-quarter cap can be overfilled after 12 quarters | Noted (low): the overfill is the schedule's last resort and is not reached on the benchmark seeds. | |
| F53 | `npm test` ran no day-long soak | = F7, F38 | |
| F54 | Touching measured between lines of no width | Fixed | 07092f9: drawn at true size; the old centreline measure still printed |
| F55 | Waits missed aircraft lined up | Fixed | cf018f0: time lined up judged against 20 minutes. A queue that creeps forward is not counted as waiting; the gate-hold and lined-up limits bound the stages either side of it. |
| F56 | Blind spots in the runway-conflict rule | Fixed | cf018f0: rolling over 10 m/s, the tower's exemption, every step, head-on in the air. The soak still runs only the West Plan; plan changes are checked by `tools/sim/scenario.ts`. |
| F57 | Cycles not per flight; 589 visits, not 600 | = F5; the plan now says the configured 600 make 589 after rounding | |
| F58 | Weather tests not specific | Noted (low); the scenario tool now fails on head-on encounters | |
| F59 | "Gates in use" counts gates that can be used | Noted (low) | |
| F60 | Unused settings; separation numbers in `tower.ts` | Fixed | 07092f9, a8cc5ed |
| F61 | Late passengers placed at their gate, skipping security (high) | Fixed | d95ad5c; `test/people.test.ts` 'places nobody part-way along after the start' fails on the old timing |
| F62 | A desk kept a sent-away party's id | = F13 | |
| F63 | Security lanes sized for two-thirds of the busiest hour | Fixed | d95ad5c: days counted by visit |
| F64 | A gate change reached only parties standing still | Partly fixed by F10: boarding checks the gate and sends a party on. A party whose new gate cannot be walked to from where it is walks straight there. | Noted |
| F65 | Cancellations and bags; boarding counted with no aircraft | Bags = F12. Boarding counted unseen for a visit that never had an aircraft at a start: noted, rare. | |
| F66 | Staff ignore the time of day in places, and do not change with shifts | Noted as a deviation from the plan's scope (see the plan's outcome): posts are staffed by the time of day; nobody hands over at a shift change. | |
| F67 | No connecting passengers | = F14 | |
| F68 | The bag balance could not fail; bags are counts, not entities | Balance = F18. Bags as counts per party with ready times, not entities moving through sorting and carts: a deviation from the plan's scope, recorded in its outcome. | |
| F69 | The tested window was mostly start-up; stuck walkers counted present | Fixed | d95ad5c (F61), 07092f9 (the day in `npm test`), bc37022 (anyone departing still inside an hour after the flight fails the day) |
| F70 | The security percentile counted only those served | Fixed | 07092f9: those still in line counted |
| F71 | Floor-plan reachability partly tested | Partly fixed: `test/terminal-plan.test.ts` checks every kind of way in. The straight-line walk when a goal cannot be reached remains. | Noted |
| F72 | Determinism with people tested for an hour | Noted (low) | |
| F73 | Merge priority ignored signals | = F21 | |
| F74 | Curb errands | = F23 | |
| F75 | The Blue Line folded through itself at Long Term Parking | Fixed | d95ad5c: a train reversing at a spur leads with its back; routes keep going the way they were through junctions (the Blue Line now runs anticlockwise, 7,237 m); `test/transit.test.ts` checks for folding and for turns sharper than 90° |
| F76 | BART vanished | = F27 | |
| F77 | Trains kept apart only on their own route | = F22 | |
| F78 | Crossing traffic passes through inside junctions | Deferred: needs conflict zones inside junctions, a change to the road model | Follow-up proposed |
| F79 | A start before 00:07 ran the clocks negative | Fixed | d95ad5c: the app starts the day before; the simulation refuses a negative start with the roads |
| F80 | A three-way merge could deadlock | Fixed | d95ad5c: a strict order |
| F81 | No road check could fail | = F26 | |
| F82 | The stuck measure was blind at signals | = F25 | |
| F83 | The road test could not catch a shortfall | Fixed | be4f0c8: stops made against given up, overlaps across lanes, curb counts on arrival. Braking limits are not checked. |
| F84 | Passengers use both | = F24 | |
| F85 | Narrow transit checks; trains not in the checksum | Fixed | da0c779, d95ad5c |
| F86 | The sweep could not measure "Fast enough" | = F30 | |
| F87 | Camera controls never checked | Fixed | d4e693d: drag, right-drag, wheel, number keys, `[` `]`, H |
| F88 | Control checks that could not fail | = F31 | |
| F89 | The load step did not check traffic; no captures of the cut-away, boards or weather | Fixed | bc37022: the first frame must be running; d4e693d: captures of each |
| F90 | Weather never reached the picture | = F35 | |
| F91 | Ground paint drew over the arrivals cut-away | Fixed | 07092f9: interior floors drawn after the paint; looked at in the capture |
| F92 | Picking near the middle only | = F34 | |
| F93 | Rooms of every level on one plane | Fixed | 07092f9 |
| F94 | Smaller interface defects | `[` at 1× (fixed, d4e693d); counters before 00:30 (= F32); the rest (bags on belts counted twice where halls are shared, the gear dipping at rotation, a notice shown in a closed panel, the arrivals cut-away scanning walkers per hall) noted as low | |
| F95 | Locale-dependent order in the simulation | Fixed | d95ad5c |
| F96 | The taxiway test did not check letters | Fixed | d95ad5c |
| F97 | Contact gates trusted from a ref match | Noted (low) | |
| F98 | The size gate checked only staged files | = F42 | |
| F99 | Boundary patterns missed some forms | Fixed | d95ad5c |
| F100 | Records: AGENTS.md's `npm test` claim; README's "no aircraft touching"; 600 visits; the projection's accuracy; an unenforced gate-hold cap; the map credit hidden with the HUD | Fixed | The claims are now true (F38, F54); the plan states 589; 07092f9 (projection, settings); d4e693d (credit stays) |
| F101 | Z-fighting on the International Terminal's curved glass (inspection) | Fixed | d4e693d: terminal parts drawn only above the terminal's roof |
| F102 | Z-fighting on the garage by the AirTrain station | Fixed | d4e693d: a footprint sharing its bigger building's wall counts as inside it |
| F103 | A truck through a wing root | Fixed | d4e693d: catering and fuel kept clear of the wing |
| F104 | Bridges docked at the wing root | = F33 | |
| F105 | Wings overlapping on neighbouring stands | Fixed | 07092f9: stands judged at true size; none touching on 11 seeds |
| F106 | The BART viaduct ending in mid-air | Fixed | d4e693d: comes down to its tunnel mouth |
| F107 | Random views on the edge of the world | Fixed | d4e693d: the camera stays over mapped ground |
| F108 | The edge of the mapped world in wide views | Noted: the extract ends there; the camera no longer looks past it | |
| F109 | A cloud-shaped block among houses | Not changed: OSM tags it `building=yes` (relation 5832393) | |
| F110 | A hatched band at the base of a facade behind a walkway (low) | Looked at again in the full sweep before merging | See verification |
| F111 | Engine nacelles open at the front (low) | Noted | |
| F112 | The preset button stayed lit after moving the camera | Fixed | d4e693d |

## Verification

Of the repairs, by the main agent, on the branch at 879fb1a:
- `npm test`: 12 files, 66 tests, in 134 s, with a day of flights (seed 7), a day of roads and a day of people among them.
- `node tools/sim/soak.ts` on all 11 seeds (7, 11, 3, 21, 42, 101, 202, 303, 404, 505, 606): every seed passes, with the stricter measures of F54–F56: every cycle of the cohort completed; no parked aircraft and no fuselages touching at true size; no runway conflicts judged every step; none head-on in the air; longest wait on the ground 877 s, at a gate 692 s, lined up 475 s; 24 to 33 s a seed.
- `tools/sim/scenario.ts`: storm and back to clear on seeds 7 and 11, fog, storm and clear on seed 7, a closure and storm on seed 3, three changes on seed 21, and both long runways closed for 50 minutes: no aircraft meeting, none flying at each other, longest wait 429 s, gate hold 632 s.
- A day of roads, seed 7: longest stand 206 s, both freeways carried 100% of their demand, 15,935 curb stops made and 682 given up.
- A day of people, seed 7: everyone and every bag accounted for, nobody lingering, under 0.01% missed a flight.
- `tools/visual/controls.mjs`: 30 of 30 through the real controls. The sweep's frame rate at 08:00, 1920×1080: 59.9 frames a second in every view measured, at 1× and at 60×.
- Captures looked at, at full resolution: the gates, AirTrain, highway, long-haul and International views by day and night, and the departures and arrivals cut-away.
- Each new check was run against the defect it is for, where one could be put back: the panel test with the old -1 (fails: 1,570 landings an hour against 8); the people test with the old timing (fails: 162 more placed); the storm and back scenario on the commit before the tower repair (fails: one pair head-on).

## Round outcome

The defects that matter are repaired, each with a check that fails on it, except F1 (by design, with its reason), F46 (no case on the benchmark seeds), and the findings noted or deferred above. Deferred to follow-ups: re-planning a taxiing departure to another runway (F1), the remaining tuning numbers into `CONFIG` (F8, F19, F28), and crossing traffic inside road junctions (F78). The repairs that change behaviour go to round 1, checked by one lane.
