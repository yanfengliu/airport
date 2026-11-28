// Tunable numbers of the simulation, in one place. Units: metres, seconds, m/s unless a name says
// otherwise.

import { CONCESSION_CONFIG } from './terminal/concession-config.ts';

export const CONFIG = {
  concessions: CONCESSION_CONFIG,
  groundService: {
    // Airport-wide dispatch teams and travel time before each can serve its next stand.
    crews: { fuel: 12, inspection: 8, cleaning: 10 },
    transferSeconds: { fuel: 120, inspection: 90, cleaning: 120 },
    // Synthetic uplift per outbound route, in kg, and delivery rate in kg per second.
    kgPerKm: { regional: 1.7, narrow: 3.0, wide: 6.2, super: 11.5 },
    localUpliftKg: { regional: 380, narrow: 650, wide: 1700, super: 2500 },
    pumpKgPerSecond: { regional: 10, narrow: 16, wide: 32, super: 48 },
    fuelSetup: 120,
    fuelCallAfter: 150,
    inspectionCallAfter: 45,
    inspectionSeconds: { regional: 360, narrow: 480, wide: 840, super: 1080 },
    followupShare: 0.045,
    followupSeconds: [600, 1500],
    cleaningSetup: 120,
    cleaningSecondsPerPassenger: { regional: 3.2, narrow: 2.7, wide: 2.8, super: 2.7 },
    // Mid-day initialization treats these older arrivals as having cleared the cabin.
    prestartPassengersGoneAfter: 1800,
    boardingSecondsPerPassengerPerDoor: 3.34,
  },
  /** Fixed step of the simulation. */
  dt: 0.5,
  /** Aircraft visits per day: each is one arrival and one departure. */
  visitsPerDay: 600,

  approach: {
    /** How far out on final an arrival first appears, measured from its touchdown point. */
    startDistance: 22_000,
    glideSlope: (3 * Math.PI) / 180,
    /** Touchdown aim point, beyond the landing threshold. */
    touchdownBeyondThreshold: 320,
    /** Speed far out, and where the slow-down to final approach speed starts and ends. */
    initialSpeed: 96,
    slowFrom: 13_000,
    slowTo: 7_500,
    /** Height at which a landing is abandoned if the runway is not clear. */
    decisionHeight: 60,
    flareHeight: 12,
  },

  runway: {
    /** Seconds between landing slots, and how many runways a slot uses, in good visibility... */
    slotVisual: 128,
    /** ...and when cloud or fog rules out side-by-side approaches. */
    slotInstrument: 120,
    /** Extra slots left empty behind a super-heavy arrival on the same runway. */
    slotsBehindSuper: 1,
    /** Shortest time between two departures from one runway, by the wake class of the first. */
    departureGap: { M: 62, H: 100, J: 130 },
    /** Margin kept between a departure passing a crossing runway and anything landing on it. */
    crossingMargin: 12,
    /** Seconds a taxiing aircraft needs to cross a runway from its hold line. */
    crossTime: 34,
    /** A landing must be this far from the threshold, in seconds, for a crossing to be allowed. */
    crossBeforeLanding: 46,
    /** Distance from a runway centreline at which crossing traffic holds when no bar is mapped. */
    holdDistance: 78,
    /**
     * Metres either side of a runway centreline within which an aircraft on the ground is on the
     * runway, whatever line it follows: crossing, lined up, turning off, or on a taxiway mapped along
     * the pavement. Beyond the widest half-span, so a wing on the runway is a body on it.
     */
    strip: 45,
    /**
     * Seconds a departure cleared onto a runway that takes no landings may be held, beyond when it
     * could otherwise roll, by traffic crossing in front of it; and the seconds it is taken to need
     * to be lined up once cleared, as far as crossing traffic is concerned.
     */
    crossHoldsDeparture: 30,
    crossLiningUp: 15,
    /** Seconds longer at the hold line that give a departure the first turn to line up. */
    firstCome: 30,
    /** A departure that has not asked to line up for this many seconds has gone elsewhere. */
    askLapses: 8,
    /** Seconds beyond the start of the approach up to which landing slots are given out. */
    slotHorizon: 240,
    /** Seconds without new landings while the runways change from one plan to the other. */
    changeover: 15 * 60,
    /**
     * Seconds after the last landing slot on a runway end before departures may take off from its
     * other end, towards where that arrival came from.
     */
    oppositeClear: 60,
    /**
     * A departure ahead on the runway is out of a landing's way once it is this far down the
     * runway, metres, and this fast, m/s; out of a following departure's way once this far.
     */
    departedAlongForLanding: 1500,
    departedSpeedForLanding: 55,
    departedAlongForTakeoff: 1700,
    /** How far down the runway, metres, the one before must be for a departure to line up behind it. */
    lineUpBehind: 600,
    /** Seconds of margin a landing leaves a departure's roll, and the line-up's own on top. */
    rollMargin: 20,
    lineUpMargin: 6,
    /** Metres past a crossing point and moving away beyond which a runway user no longer holds a crossing. */
    crossingPassed: 90,
    /** Margin on the longest roll to rotation when judging whether a runway is long enough, and metres to line up. */
    rollShare: 1.15,
    lineUpLength: 150,
    brakingHard: 2.5,
    brakingEasy: 1.4,
    takeoffAccel: { regional: 2.5, narrow: 2.3, wide: 1.9, super: 1.7 },
    climbRate: 13,
  },

  taxi: {
    /** Metres two parked aircraft keep between them, drawn at their true size, wings and all. */
    outlineGap: 1,
    accel: 0.9,
    decel: 1.2,
    pushbackSpeed: 2.1,
    /** Seconds from the end of pushback until the aircraft taxis: engine start, tug away. */
    engineStart: [110, 200] as [number, number],
    /** Body length is padded by this much when reserving ground. */
    bodyMargin: 9,
    /** Aircraft queued for one runway before more are held at their stands. */
    queueLimit: 7,
  },

  schedule: {
    /** Departures the runways can take in a quarter of an hour, in all and on the long runways. */
    departuresPerQuarter: 11,
    longRunwayDeparturesPerQuarter: 3,
  },

  weather: {
    /** Tailwind on the 28s, knots, beyond which the airport turns to the Southeast Plan, and below which it turns back. */
    turnSoutheast: 8,
    turnWest: 3,
    /** Side-by-side approaches need at least this ceiling, feet, and visibility, miles. */
    pairedCeiling: 1_600,
    pairedVisibility: 4,
  },

  turnaround: {
    /** Minutes before departure at which boarding starts and at which doors close. */
    boardingStarts: { regional: 28, narrow: 36, wide: 50, super: 60 },
    doorsClose: 7,
    /**
     * Minutes before the doors close from which a passenger not yet at the gate runs for it, and
     * how fast, metres a second: about the pace of the characters' built-in run, which carries
     * them some 4.3 m a cycle. A party of three or more, with children in it, walks briskly instead.
     */
    hurryFrom: 12,
    run: [3.2, 4.0] as [number, number],
    brisk: [1.5, 1.7] as [number, number],
    /** Seconds from parking until the jet bridge is on and doors open. */
    bridgeOn: [70, 130] as [number, number],
  },

  transit: {
    /** November 2026 Terminal 3 West construction. Both lines use the combined T2/T3 station. */
    closedAirTrainStation: 'Terminal 3',
    /**
     * Each kind of train's cars, metres: the length of a car coupled to the next, and the width of
     * its body. These are the bodies the shared track is worked for: wherever two of them could
     * touch, one train at a time.
     */
    cars: {
      airtrain: { length: 11.8, width: 2.8 },
      bart: { length: 21.3, width: 3.2 },
      caltrain: { length: 26, width: 3.2 },
    },
    /** Room kept between the bodies of two trains on tracks side by side; any closer, and the track there is one block. */
    passingClearance: 0.3,
  },

  curbTraffic: {
    /** Curb vehicles represented per local passenger, including shared rides and shuttles. */
    tripsPerPassenger: 0.14,
    /** Minimum, peak and maximum time differences, in minutes before departure or after parking. */
    domesticDeparture: [45, 105, 180],
    internationalDeparture: [90, 160, 240],
    domesticArrival: [6, 22, 55],
    customsArrival: [18, 45, 90],
    /** Eligible curb frontages extend up to this far beyond the one closest to the hall, metres. */
    frontageSpread: 65,
  },

  travellers: {
    /**
     * Of departing travellers with no bags to check, the share who cut it fine, and how fine:
     * minutes before departure they come, at random between these (half as much again for a
     * flight abroad). Some of them run for the gate.
     */
    lateShare: 0.12,
    lateLead: [20, 45] as [number, number],
  },

  staff: {
    /** Shifts start at this hour of the day and last this many hours: at each start the posts change hands. */
    shiftsFrom: 6,
    shiftHours: 8,
    /** Hours of the day the shops and places to eat are open, staffed and taking money. */
    shopsOpen: [5, 23.5] as [number, number],
  },
} as const;

export type BodyKey = keyof typeof CONFIG.runway.takeoffAccel;
