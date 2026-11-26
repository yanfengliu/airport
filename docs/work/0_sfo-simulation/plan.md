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

- [ ] **M0 Foundation.** Repo shape under the fleet rules, toolchain, OSM fetch and layout build, committed layout with provenance, layout tests, this plan. Merged and pushed.
- [ ] **M1 The place.** The static 3D airport from the layout, sky and time of day, camera controls and presets, the visual sweep tool. Merged and pushed.
- [ ] **M2 Airside.** Schedule, weather and runway configuration, tower and ground control, taxi reservations, gates, turnaround and ground equipment, aircraft models, a first flight board. Soak and determinism tests. Merged and pushed.
- [ ] **M3 Roads and transit.** Road traffic, curbs, garages, shuttles, taxis and buses, AirTrain and BART, vehicle models. Soak test. Merged and pushed.
- [ ] **M4 People and bags.** Terminal interiors, passengers, check-in, security, shops, gates, customs, baggage system and carousels, staff. Conservation tests. Merged and pushed.
- [ ] **M5 Orchestration and interface.** Operations layer and panel, interventions, inspector and follow mode, full flight boards, night lighting, performance pass, README. Merged and pushed.
- [ ] **M6 Acceptance.** Independent review by both lanes, repairs and their recheck, full visual sweep, every criterion above checked and recorded, final merge and push, worktree and branch removed.

## Outcome

Pending while work is open.
