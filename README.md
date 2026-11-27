# airport

A simulation of San Francisco International Airport in the browser. The airfield, terminals, gates, roads and rail are the real ones, from OpenStreetMap, and one deterministic simulation runs everything that moves on them: aircraft landing, taxiing, turning round and taking off under a tower and ground control; road traffic on US-101, I-380 and the terminal loop; AirTrain, BART and Caltrain; and passengers, bags, security, shops and staff inside the terminals. It is drawn in 3D with three.js, by day and by night.

## Running it

Node 24 or later.

```bash
npm ci
npm run dev
```

Then open the address Vite prints. `npm run build && npm run preview` serves the production build instead.

The page takes a few parameters: `t=14:30` starts at that time of day, `seed=7` picks the day's schedule, `view=terminals` a camera preset, `speed=15` the speed, `weather=fog` the weather (`clear`, `low-cloud`, `fog`, `storm`), `inside=departures` the cut-away view, `board=1` opens the flight board and `ops=0` closes the operations panel.

## Controls

- Drag to pan; right-drag, or drag with Shift held, to turn and tilt; wheel to zoom. The number keys go to the camera presets along the bottom. W, A, S and D pan, Q and E turn, R and V tilt, Z and X zoom.
- Space pauses; `[` and `]` change speed (1×, 5×, 15×, 60×); the top bar jumps to dawn, day, dusk or night.
- `I` lifts the terminal roofs to show the departures level, then the arrivals level.
- `O` opens the operations panel: the runway plan, weather, landing and take-off rates, delays, gates, every security checkpoint, bags, road speeds and an event log. Its buttons change the weather, close runways and close checkpoints, and the airport responds. A closed runway takes no new traffic, while aircraft already on their way to it still use it; a closed checkpoint works through its line and sends new travellers to the next one.
- `B` opens the departure and arrival boards. Click a row, or click an aircraft anywhere on it on the map, to see its card; `F` follows it with the camera and `Esc` lets it go.
- `H` hides everything but the view and the map's credit.
- The weather set on the panel shows in the picture too: fog and low cloud close in, a storm darkens the sky.

## What is simulated

- **Aircraft.** About 600 visits a day (589 once each airline's share is rounded) by the airlines that fly to SFO with the types they fly, on a schedule shaped like SFO's day and fitted to what the runways can take. The tower gives landing slots, clears line-ups, take-offs and runway crossings, and never sends a departure towards an arrival coming the other way; ground control keeps every aircraft's fuselage on ground nobody else holds, in one order of right of way, so no two meet and nothing locks up. Stands are chosen for the ways in and out an aircraft would really take, and so that no two parked aircraft come within a metre of each other, wings and all. Ground equipment works round parked aircraft, and jet bridges swing out to the forward door.
- **Weather and runways.** A west wind lands aircraft on 28L and 28R and launches them from 1L and 1R; a southeast wind turns the airport round to the Southeast Plan; low cloud or fog leaves one arrival stream. Runways and checkpoints can be closed.
- **Roads and rail.** Cars, taxis, shuttles, buses and trucks follow the car ahead, change lanes and merge, and make drop-offs, pick-ups and trips to the garages, going round again if they miss the curb. AirTrain runs both lines; BART and Caltrain run to their stations; trains on shared track take it one at a time.
- **People.** Travellers in parties come by car, train or garage, pull their suitcases to check-in, queue at security, browse the shops and sit to eat, sit at their gate and board when their group is called; arrivals clear customs, wait round their flight's carousel and leave with their bags. In a line each stands their own way and steps up when a gap opens. Those who come or go by AirTrain or BART ride the trains. Some change planes airside. Lanes and desks open and close with the lines, staff hand over their posts at 06:00, 14:00 and 22:00, and the shops close at night. Everyone and every bag is accounted for; bags are counted per party, not followed one by one.
- **The terminals inside.** Check-in desks with their bag belts, kiosks, security lanes with x-ray belts and body scanners, passport booths, gate desks and seats, carousels, shops with shelves, cafés with tables, lounges, plants and stanchions, laid out in the mapped rooms by the simulation, which seats people in them and keeps walkers clear of them.

## Checking it

- `npm run typecheck`, `npm test`, `npm run build` and `npm run audit` are the gates. `npm test` runs a whole day of flights, of roads and of people among its tests, about two minutes in all.
- `node tools/sim/soak.ts` is the airside benchmark: a full day for each of several seeds, judged against fixed limits (whole cycles completed, waits on the ground, at the gate and lined up, go-arounds, no runway conflicts, no aircraft touching, drawn at their true size).
- `node tools/sim/scenario.ts --weather storm@11:00 --close 28L@13:00` tells what the airport does through a change of weather or a closure, hour by hour, and fails if aircraft meet or fly at each other.
- `node tools/sim/roads.ts --hours 24 --start 04:00` and `node tools/sim/people.ts --start 04:00 --hours 24` run and judge a day of roads and of people.
- `npm run visual` drives the built app on the GPU through its real controls, writes full-resolution captures, and measures the frame rate at the morning peak with the clock running; `node tools/visual/controls.mjs` checks every control does what it says.

The plan, its acceptance criteria and the record of the work are in [docs/work/0_sfo-simulation/plan.md](docs/work/0_sfo-simulation/plan.md).

## Models

The furniture, luggage and people inside the terminals, and the ground equipment round the aircraft, are [Polyfork](https://polyfork.dev)'s free low-poly models, whose mesh files are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). `node tools/models/polyfork.ts` takes what each listed model is (title, page, real size) from a local index of Polyfork's catalogue (`--dataset`, by default `../3d-maker/dataset/polyfork`), its GLB from there or, failing that, from the index's link once (into `artifacts/`, not tracked), and converts each into the compact form the app loads, in `public/models/`: welded and quantized, colours as slots so people can be dressed differently, and characters with frames of their own built-in Walk, Idle and Run clips and a sitting pose. `public/models/CREDITS.md` credits every model and says what was changed. Polyfork does not endorse this project.

## Data and licence

The airport's geometry is from [OpenStreetMap](https://www.openstreetmap.org/copyright), © OpenStreetMap contributors, available under the [Open Database License](https://opendatacommons.org/licenses/odbl/). `public/data/` is built from it by `npm run data:build` (after `npm run data:fetch`); `public/data/provenance.json` records the query, its date and the licence, and the app shows the attribution on screen.

Schedules, airlines' shares, passenger loads and every other number are synthetic, shaped to look like SFO's day; nothing is live or real flight data.

The code is under the MIT licence; see [LICENSE](LICENSE).
