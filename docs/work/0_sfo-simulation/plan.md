# SFO airport simulation

Status: active
Owner: Claude Code session in airport worktree sfo-sim
Created: 2026-11-26
Updated: 2026-11-26

## Problem and outcome

The repository is empty. The owner asked for a realistic simulation of San Francisco International Airport, "including but not limited to graphics, traffic, orchestration, airplanes, travelers, staff, the highway coming in and out, luggage, security, shops", built to a plan that is then kept, under the fleet rules.

Outcome: a browser application that opens on a working 3D SFO drawn from real map geometry. Aircraft, vehicles, trains, people and bags move through connected systems run by one deterministic simulation. The viewer can watch any part of it, follow any one thing, and see how the airport is being run.

## Scope

Included, each as a system that feeds the others:

- **The place.** Runways, taxiways, aprons, stands, jet bridges, terminals, the control tower, hangars, garages, US-101, I-380, the two-level terminal loop, AirTrain, BART, the bay shoreline and the towns to the west, all from OpenStreetMap.
- **Aircraft.** A day's schedule shaped like SFO's; approach, landing, runway exit, taxi, parking, turnaround, pushback, taxi out, line-up, take-off and climb; ten or so aircraft types at true size in airline colours.
- **Air traffic and ground control.** Runway configuration from the wind; paired arrivals on 28L and 28R with departures off 01L and 01R through the gaps, heavy departures off the 28s; separation by wake class; hold-short and runway-crossing clearances; taxi routing with conflict-free reservations; gate assignment by airline, size and occupancy.
- **Ground handling.** Pushback tugs, baggage tugs with cart trains, belt loaders, fuel and catering trucks, jet bridges that dock and retract.
- **Roads.** Car-following and lane-changing traffic on US-101, I-380, the ramps and the terminal loop; drop-off and pick-up at the departures and arrivals curbs; garages, taxis, ride-hail, shuttles and buses.
- **Transit.** AirTrain red and blue lines on the real guideway; BART to the International Terminal.
- **Travelers.** Each passenger is one agent: arrives by a ground mode, checks in if carrying bags, clears security, may shop or eat, waits at the gate, boards. Arriving passengers deplane, clear customs when international, collect bags and leave. Connecting passengers transfer.
- **Luggage.** Each checked bag is one entity tied to a passenger and a flight, moving from check-in through sorting to carts to the hold, and from the hold to a carousel to its owner.
- **Security.** Checkpoints with lanes, queues and measured waits.
- **Shops.** Concessions on every concourse with staff, customers and takings.
- **Staff.** Security officers, check-in and gate agents, ramp crews, cleaners, shop workers and tower controllers on shifts, at their posts.
- **Orchestration.** An operations layer that sequences runways, assigns gates, staffs security lanes, allocates carousels, absorbs delays and logs what it did; a panel that shows it; controls to change the wind or visibility, or close a runway or a checkpoint, and watch the response.
- **Graphics and controls.** Sun and sky through the day, night lighting, cut-away terminal roofs, map-style camera, presets, follow mode, click to inspect, flight boards, pause and time acceleration.

Excluded: live flight data and real timetables (the schedule is synthetic, shaped like SFO's); airline logos and liveries (codes and plain colours only); satellite imagery and photorealism; interior architecture beyond what the public map holds (interiors are generated from footprints, mapped doors, gates, check-in areas and claims); save files, multiplayer, a mobile layout; deployment or publishing.

Dependencies: `three` at run time; `vite`, `typescript`, `vitest` and `playwright` for development; OpenStreetMap data under the ODbL, attributed in the app, the README and `public/data/provenance.json`. The stack is the one this fleet's other browser simulations use.

Ownership: the main agent owns the plan, the contracts, integration and acceptance, and implements directly. Bounded, independent pieces with a written contract (procedural models) may go to a subagent in its own worktree; the main agent inspects the result itself before merging. Everything happens in the worktree `../../worktrees/airport-sfo-sim` on branch `sfo-sim`, and each milestone below is merged to main and pushed. The fleet repo is not changed: adding `airport` to its census is left to the owner.

## Approach

**Real geometry first.** `tools/osm/fetch.mjs` pulls a themed extract of the airport and its surroundings from the Overpass API; `tools/osm/build-layout.ts` turns it into six compact layout files under `public/data/` (airfield, terminals, roads, rail, buildings, land) in local metres, each under 1 MiB, plus provenance. The raw extract stays in ignored `artifacts/`. The taxi graph, the stands with their real gate numbers and the road graph that traffic drives on are the mapped ones, not sketches.

**One deterministic simulation, separate from drawing.** `src/sim/` is plain TypeScript with no DOM and no three.js: a fixed time step, a seeded random source, and state in flat arrays where there are thousands of things. It runs the same in the browser and under Vitest in Node, which is what makes day-long soak tests and determinism checks possible. `src/render/` reads simulation state and draws it with three.js, merged static geometry plus instanced meshes for everything that moves. `src/ui/` is plain DOM. `src/app/` wires them and exposes `window.render_game_to_text()` and `window.advanceTime(ms)` for automated checks.

**Movement models.** Aircraft follow the taxi graph nose-wheel-on-the-line with the body trailing, and hold a reservation on the edges and nodes ahead so two aircraft never meet head-on. Runways are resources the tower model grants. Road vehicles use the Intelligent Driver Model per lane with rule-based lane changes and zipper merges. People move on a walkable grid per terminal level along precomputed distance fields with a cap on people per cell, which gives queues and crowding without pairwise forces; counters, lanes, gates and carousels are explicit queues with service times.

**Checks sized to the claim.** Invariants run headless over a simulated day: conservation of passengers and bags, runway separation, no overlap at stands, bounded waits, no gridlock, determinism. Pixels are checked by `npm run visual`, which drives the built app in headless Chromium on the GPU through real mouse and keyboard input, from fixed and seeded-random views at day, dusk and night, and writes full-resolution captures to `artifacts/`; each is looked at. A running, uncommitted gallery of those captures is kept at `artifacts/gallery/index.html` at the owner's request (2026-11-25).

**Review.** The integrated build gets one independent review by both lanes of the fleet runbook before the unit closes; repairs that change behaviour are checked by one lane. Records go in `reviews/`.

## Acceptance criteria

- [ ] **Runs.** `npm ci && npm run build && npm run preview` serves the app, and the first interactive frame shows the airport with traffic already moving. Checked by the visual sweep's load step.
- [ ] **Real layout.** The four runways (lengths within 1% of the published 3,618 m, 3,469 m, 2,636 m and 2,332 m), the lettered taxiways, at least 100 numbered contact gates, the terminals, US-101, I-380, the terminal loop, AirTrain and BART come from the committed OSM-derived files; provenance and ODbL attribution are in the app. Checked by layout tests and by looking.
- [ ] **A day of flights.** Over a simulated 24 hours in the West Plan at least 95% of scheduled flights complete their full cycle, with zero runway-separation violations, zero overlapping aircraft at stands and no aircraft waiting more than 20 minutes for a taxi clearance. Checked by a soak test.
- [ ] **Weather drives the runways.** Wind selects the West or the Southeast Plan, and low visibility drops arrivals to a single stream, with the resulting delays on the flight board. Checked by scenario tests and in the app.
- [ ] **Roads flow.** US-101, I-380 and the terminal loop carry traffic that follows, changes lanes and merges; vehicles reach curbs and garages and leave; over 24 hours no vehicle is stuck for more than 10 minutes and freeway throughput stays within 20% of demand. Checked by a soak test.
- [ ] **Every passenger is accounted for.** Departing, arriving and connecting passengers complete their journeys; everyone created is boarded, gone landside or still present; under normal operations fewer than 2% miss a flight. Checked by a soak test.
- [ ] **Every bag is accounted for.** Each checked bag ends on its flight or with its owner; fewer than 1% are mishandled under normal operations, and the number is reported. Checked by a soak test.
- [ ] **Security works as a system.** Lanes open and close with staffing, waits are measured, and the 95th-percentile wait on a normal day is under 30 minutes. Checked by a soak test and in the app.
- [ ] **Shops and staff are present.** Concessions serve customers and report takings by terminal; staff of each role appear at their posts and change with the shift. Checked by tests on counts and by looking.
- [ ] **Transit runs.** AirTrain stops at its stations on both lines, BART arrives at its station, and passengers use both. Checked by tests and by looking.
- [ ] **Orchestration is visible and responds.** The operations panel shows runway configuration, arrival and departure rates, delays, gate occupancy, checkpoint waits, bag system load, road speeds and an event log; changing the wind or visibility, or closing a runway or a checkpoint, changes what the airport does. Checked through the real controls.
- [ ] **It looks like an airport, day and night.** At 2560×1440, twelve fixed views and twelve seeded-random views at day, dusk and night show correct, unbroken scenes: no z-fighting sheets, floating or buried objects, missing meshes, unlit night scenes or unreadable text. Each capture is inspected at full resolution.
- [ ] **Controls work through real input.** Pan, orbit, zoom, presets, follow, click-to-inspect, pause, speed and the flight boards are driven by Playwright mouse and keyboard events and observed to work.
- [ ] **Fast enough.** At the morning peak at 1920×1080 on this machine's GPU the app holds at least 45 frames a second at 1× and at least 20 at 60×. Measured in the sweep and recorded.
- [ ] **Deterministic.** The same seed gives the same state hash after six simulated hours, twice. Checked by a test.
- [ ] **Gates and records.** Typecheck, tests, build and audit pass on the tree that reaches main; no tracked file is over 1 MiB and no binary over 512 KiB; `AGENTS.md`, the devlog and this plan's outcome are current; the review records are in `reviews/`.

## Implementation steps

- [x] **M0 Foundation.** Repo shape under the fleet rules, toolchain, OSM fetch and layout build, committed layout with provenance, layout tests, this plan. Merged and pushed (a3fcf40, 2026-11-25).
- [x] **M1 The place.** The static 3D airport from the layout, sky and time of day, camera controls and presets, the visual sweep tool. Merged and pushed (a3fcf40, 2026-11-25).
- [x] **M2 Airside.** Schedule, weather and runway configuration, tower and ground control, taxi reservations, gates, turnaround and ground equipment, aircraft models, a first flight board. Soak and determinism tests. Merged and pushed (bc9832a, 2026-11-26), after the hard-problem search above; weather and runway configuration came with M5 (f957ac0), and the ground equipment too (14da121).
- [x] **M3 Roads and transit.** Road traffic, curbs, garages, shuttles, taxis and buses, AirTrain and BART, vehicle models. Soak test. Merged and pushed (30e7f04, 2026-11-26). The tests run 40 minutes of the morning peak, not a day: the day-long road criterion is checked in M6 with `tools/sim/roads.ts`. Road errands are not tied to passengers.
- [x] **M4 People and bags.** Terminal interiors, passengers, check-in, security, shops, gates, customs, baggage system and carousels, staff. Conservation tests. Merged and pushed (bc9832a, 2026-11-26).
- [ ] **M5 Orchestration and interface.** Operations layer and panel, interventions, inspector and follow mode, full flight boards, night lighting, performance pass, README. Merged and pushed. Also carried here from M2: the ground equipment round a parked aircraft. Done on `sfo-sim` up to 52707e8: the panel, weather, runway and checkpoint closures, boards, inspector and follow (`tools/visual/controls.mjs`, 18 of 18), ground equipment, jet bridges that move, README; 60 frames a second in every view at 1× and 60× at the morning peak at 1920×1080 (Apple M3).
- [ ] **M6 Acceptance.** Independent review by both lanes, repairs and their recheck, full visual sweep, every criterion above checked and recorded, final merge and push, worktree and branch removed.

## Ground traffic: hard-problem search

Opened 2026-11-25 under `../fleet/docs/skills/hard-problem.md`, after more than five repair attempts at one problem: aircraft on the ground lock up, or pass through each other.

**Done-condition, written before the search.** `node tools/sim/soak.ts` exits 0 on the tuning seeds 7, 11, 3, 21 and 42, and on held-out seeds the coordinator keeps to itself until the final check. Per seed, over 26 simulated hours from 04:00 with the configured 600 visits a day: at least 99% of flights land and at least 99% take off; no aircraft waits more than 20 minutes for the way ahead; go-arounds are at most 3% of landings; no two parked aircraft overlap; no two fuselages come within four metres on the ground; no claim is released out of order; nothing is stuck at the end; at least 85 numbered gates are in use; the run takes under 60 seconds.

**Disqualifiers, written before any candidate.** Passing the tuning seeds only. Changing `tools/sim/soak.ts` or its limits. Removing, teleporting or ghosting aircraft, or cancelling flights, to clear a jam. Cutting traffic below the configured day, or cutting runway capacity below what the schedule needs. Moving an aircraft backwards anywhere but a pushback. Using fewer than 85 gates. Anything that depends on wall-clock time or is not repeatable from the seed. Relocating the difficulty behind an interface without solving it.

**Attempts before the search** (all on branch `sfo-sim`; measurements are the old 26-hour run without the collision checks, so they overstate success):

| Commit | Mechanism | Result | Status |
| --- | --- | --- | --- |
| 6917acf | Precedence queues from a timetable, clearance limits moved a stretch at a time; one-way cost on ring taxiways A and B; never close in on an oncoming holder. | Clean to 08:35 on seed 7, then a jam. | Superseded. |
| bc05115 | Adds a cost for routing against where others are routed, and no runway exit into an oncoming route. | Seeds 7 and 42 complete a day (longest wait 36 and 54 minutes); 11, 3 and 21 lock up. | Kept as a baseline. |
| 4ef58da | Every journey has a fixed route and a ticket; nobody is cleared onto a stretch an earlier journey still has to come down the other way, nor left across a junction on its way; routes use only their own stand's line. | Seeds 3 and 21 complete (longest wait 12 minutes); 7, 11 and 42 lock up. | Current head. |

**What the benchmark showed at 4ef58da** (first run with the collision checks): all five seeds fail. On the two that complete, 74 to 76 pairs of fuselages meet in a day (crossing a runway in front of a lined-up aircraft; merges at shallow angles; a pushback through a parked neighbour), one pair of parked aircraft overlaps, and go-arounds are 22 to 32 against a limit of 17, all from wide-body departures lined up on a landing runway. So the control is wrong in two ways at once: it does not always keep aircraft apart, and it does not always keep them moving.

**Branches** are recorded below as they report.

| Branch | Mechanism family | State | Next |
| --- | --- | --- | --- |
| `hp-structure` (e4ffe14) | Structure: directions of travel, zones with entry rules, interlocking. | Interlocking written, not wired in; nothing runs. Cut off on 2026-11-25 by a usage limit, not by a result. | Parked as the fallback. |
| `hp-reservation` (97f6026) | Reservation in space and time. | Nothing committed before the same usage limit. | Not resumed. |
| `hp-repair` (3001b2e) | Instrument, trace, repair: `tools/sim/trace.ts` classifies every meeting and follows every long wait to its cause; ground cut into 5 m tiles held by fuselages; every journey wants its whole way and has a place in one order, and takes a tile only when nobody earlier wants it. | Six hours of seed 7 traced, benchmark not yet run. Cut off by the same usage limit. | Continued as `hp-repair-2` by a fresh owner on 2026-11-26: the only branch with a mechanism that runs and evidence to judge it by. |
| `hp-repair-2` (1e15b15) | The same, and: a runway is a strip of ground 45 m either side of its centreline, whatever line the map draws on it; a landing fixes its way off the runway and its stand at decision height; an arrival with no free stand is held before its approach; no stand is used where its aircraft would shut a neighbour in; a departure lines up only when its take-off can follow before the next landing. | Coordinator's own run, 2026-11-26: the five tuning seeds give the owner's checksums; 7 of 8 seeds pass, held-out 101, 202 and 303 among them; no fuselages meet and nothing locks up. Seed 11 fails on a 2,248 s wait to cross a runway. Not counted by the benchmark, and found by the coordinator's audit: departures held at their stands after they were ready for up to 6,890 s, on three of four seeds. | Merged into `sfo-sim` (1565211); its two gaps repaired there, below. |

Running one branch rather than three is a choice of cost, not of evidence: the three earlier owners and the coordinator together ran out of one model's usage within hours.

**Repairs after the merge** (on `sfo-sim`, each traced to its cause with `tools/sim/trace.ts` and scratch probes before it was changed):

| Cause found | Repair |
| --- | --- |
| Departures at R76 held 66 to 115 minutes on three seeds. For the A380 there on seed 3, 12 of its 13 ways of pushing back lead to no runway, and the one that does runs over aircraft parked at R79 and R80. The stand rule counted the dead ends as ways out. | A way of pushing back counts only if it leads to a runway the aircraft may use under the plan in force. A departure with no way at all to its preferred runway tries the other of the same kind. |
| 16 of 17 go-arounds on seed 7 were arrivals finding no stand at decision height: a B777 parked at R80 rests on ground that the way in to G4, G7 and G8 sweeps where a long fuselage follows a bend in the taxiway. The stand rule looked only at each stand's own line. | An arrival's stand is chosen before its approach against the ways in the landing would really try, and another stand is taken if every one runs over ground an aircraft rests on or will rest on. No stand is free if its aircraft would rest on ground an arrival still has to pass over. |
| The seed 11 crossing wait: a runway that takes only departures was never crossed while it had a queue, because the next departure lined up before the last had passed the crossing. | A departure lined up and waiting on such a runway lets traffic cross in front of it, if that holds it up by no more than 30 s; a departure may line up while traffic crosses downfield, and still rolls only once the crossing is over. |
| A departure at one hold line waited 20 minutes while others at other hold lines of the same runway were cleared, whoever asked first after the runway freed. | Departures line up in the order they reached the hold lines, unless the first could not take the clearance it was given. |
| Wide-bodies waited 20 minutes for a gap in the landings in the evening arrival push: with a backlog every landing slot was already given out 20 minutes ahead, so the gap went after them all. | Landing slots are given out only up to four minutes beyond the start of the approach. |
| The schedule asked for 65 departures in the 22:00 hour, 18 of them wide-bodies needing gaps in the landings; the runways managed about 50 with the arrivals of that hour. | The schedule fits its departures to the runways, as a coordinated airport's does: at most 11 a quarter hour, 3 of them on the long runways; a departure that would overfill its quarter goes in the next with room. The day keeps its 600 visits. |

**Benchmark change.** `tools/sim/soak.ts` also fails a seed on any departure held at its stand more than 20 minutes after it is ready (doors closed, departure time reached). The evidence that the old measures misstated the requirement: the acceptance criterion is "no aircraft waiting more than 20 minutes for a taxi clearance", a departure refused pushback is waiting for one, and runs that passed every old limit held departures at their stands for up to 6,890 s. The old measures and their limits are unchanged.

## Outcome

Pending while work is open.
