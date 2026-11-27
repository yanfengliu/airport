// Tunable numbers of the simulation, in one place. Units: metres, seconds, m/s unless a name says
// otherwise.

export const CONFIG = {
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
    brakingHard: 2.5,
    brakingEasy: 1.4,
    takeoffAccel: { regional: 2.5, narrow: 2.3, wide: 1.9, super: 1.7 },
    climbRate: 13,
  },

  taxi: {
    accel: 0.9,
    decel: 1.2,
    pushbackSpeed: 2.1,
    /** Seconds from the end of pushback until the aircraft taxis: engine start, tug away. */
    engineStart: [110, 200] as [number, number],
    /** How often an aircraft that cannot proceed asks again. */
    retry: 6,
    /** Longest a departure is held at its stand waiting for a clear way out. */
    maxGateHold: 900,
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
    /** Seconds from parking until the jet bridge is on and doors open. */
    bridgeOn: [70, 130] as [number, number],
  },
} as const;

export type BodyKey = keyof typeof CONFIG.runway.takeoffAccel;
