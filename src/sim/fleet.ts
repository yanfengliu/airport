// Aircraft types, airlines and the places they fly to. Dimensions are the published ones for each
// type; the airline mix, colours and gate areas are shaped like SFO's without copying a timetable.

export type WakeClass = 'M' | 'H' | 'J';
export type BodyClass = 'regional' | 'narrow' | 'wide' | 'super';

export interface AircraftType {
  /** ICAO type designator. */
  id: string;
  name: string;
  body: BodyClass;
  wake: WakeClass;
  /** Metres. */
  span: number;
  length: number;
  height: number;
  fuselage: number;
  engines: 2 | 4;
  seats: number;
  /** Final approach speed, m/s. */
  vApp: number;
  /** Rotation speed, m/s. */
  vRot: number;
  /** Shortest and usual time at the gate, minutes. */
  turn: [number, number];
  /** Doors used for boarding. */
  doors: 1 | 2;
}

const type = (id: string, name: string, body: BodyClass, wake: WakeClass, span: number, length: number, height: number, fuselage: number, engines: 2 | 4, seats: number, vApp: number, vRot: number, turn: [number, number], doors: 1 | 2): AircraftType => ({
  id, name, body, wake, span, length, height, fuselage, engines, seats, vApp, vRot, turn, doors,
});

export const AIRCRAFT: Record<string, AircraftType> = Object.fromEntries(
  [
    type('E75L', 'Embraer 175', 'regional', 'M', 28.7, 31.7, 9.9, 3.0, 2, 76, 64, 66, [30, 42], 1),
    type('BCS3', 'Airbus A220-300', 'narrow', 'M', 35.1, 38.7, 11.5, 3.5, 2, 140, 67, 70, [35, 50], 1),
    type('A320', 'Airbus A320', 'narrow', 'M', 35.8, 37.6, 11.8, 3.95, 2, 162, 70, 74, [40, 55], 1),
    type('A21N', 'Airbus A321neo', 'narrow', 'M', 35.8, 44.5, 11.8, 3.95, 2, 196, 72, 78, [45, 62], 1),
    type('B738', 'Boeing 737-800', 'narrow', 'M', 35.8, 39.5, 12.5, 3.76, 2, 166, 73, 76, [40, 55], 1),
    type('B39M', 'Boeing 737 MAX 9', 'narrow', 'M', 35.9, 42.2, 12.3, 3.76, 2, 178, 74, 78, [42, 58], 1),
    type('B752', 'Boeing 757-200', 'narrow', 'M', 38.0, 47.3, 13.6, 3.76, 2, 176, 68, 74, [50, 70], 1),
    type('B789', 'Boeing 787-9', 'wide', 'H', 60.1, 62.8, 17.0, 5.77, 2, 257, 74, 82, [90, 140], 2),
    type('A359', 'Airbus A350-900', 'wide', 'H', 64.75, 66.8, 17.05, 5.96, 2, 315, 72, 80, [95, 150], 2),
    type('B77W', 'Boeing 777-300ER', 'wide', 'H', 64.8, 73.9, 18.5, 6.2, 2, 350, 77, 86, [100, 160], 2),
    type('A388', 'Airbus A380-800', 'super', 'J', 79.75, 72.7, 24.1, 7.14, 4, 485, 72, 82, [120, 180], 2),
  ].map((t) => [t.id, t]),
);

export type Region = 'west' | 'mountain' | 'central' | 'east' | 'hawaii' | 'canada' | 'latin' | 'europe' | 'asia' | 'oceania' | 'gulf';

export interface Destination {
  code: string;
  city: string;
  km: number;
  region: Region;
  international: boolean;
}

const place = (code: string, city: string, km: number, region: Region): Destination => ({
  code, city, km, region, international: !['west', 'mountain', 'central', 'east', 'hawaii'].includes(region),
});

export const DESTINATIONS: Record<string, Destination> = Object.fromEntries(
  [
    place('LAX', 'Los Angeles', 543, 'west'), place('SAN', 'San Diego', 720, 'west'), place('LAS', 'Las Vegas', 667, 'west'),
    place('SEA', 'Seattle', 1093, 'west'), place('PDX', 'Portland', 885, 'west'), place('SNA', 'Orange County', 600, 'west'),
    place('BUR', 'Burbank', 525, 'west'), place('PSP', 'Palm Springs', 680, 'west'), place('RNO', 'Reno', 310, 'west'),
    place('SBA', 'Santa Barbara', 420, 'west'), place('EUG', 'Eugene', 720, 'west'), place('MFR', 'Medford', 530, 'west'),
    place('FAT', 'Fresno', 255, 'west'), place('ACV', 'Arcata', 400, 'west'), place('RDM', 'Redmond', 740, 'west'),
    place('GEG', 'Spokane', 1180, 'west'), place('BOI', 'Boise', 840, 'mountain'), place('SLC', 'Salt Lake City', 964, 'mountain'),
    place('PHX', 'Phoenix', 1048, 'mountain'), place('TUS', 'Tucson', 1210, 'mountain'), place('DEN', 'Denver', 1554, 'mountain'),
    place('ABQ', 'Albuquerque', 1440, 'mountain'), place('BZN', 'Bozeman', 1300, 'mountain'), place('JAC', 'Jackson Hole', 1190, 'mountain'),
    place('DFW', 'Dallas', 2358, 'central'), place('IAH', 'Houston', 2630, 'central'), place('AUS', 'Austin', 2410, 'central'),
    place('ORD', 'Chicago', 2970, 'central'), place('MSP', 'Minneapolis', 2553, 'central'), place('STL', 'St. Louis', 2790, 'central'),
    place('MCI', 'Kansas City', 2400, 'central'), place('BNA', 'Nashville', 3170, 'central'), place('MSY', 'New Orleans', 3090, 'central'),
    place('DTW', 'Detroit', 3350, 'east'), place('ATL', 'Atlanta', 3440, 'east'), place('MIA', 'Miami', 4160, 'east'),
    place('MCO', 'Orlando', 3920, 'east'), place('CLT', 'Charlotte', 3690, 'east'), place('IAD', 'Washington Dulles', 3890, 'east'),
    place('DCA', 'Washington National', 3930, 'east'), place('PHL', 'Philadelphia', 4050, 'east'), place('EWR', 'Newark', 4130, 'east'),
    place('JFK', 'New York', 4160, 'east'), place('BOS', 'Boston', 4350, 'east'), place('RDU', 'Raleigh', 3860, 'east'),
    place('TPA', 'Tampa', 3850, 'east'), place('FLL', 'Fort Lauderdale', 4150, 'east'), place('PIT', 'Pittsburgh', 3640, 'east'),
    place('CLE', 'Cleveland', 3460, 'east'), place('HNL', 'Honolulu', 3860, 'hawaii'), place('OGG', 'Maui', 3770, 'hawaii'),
    place('KOA', 'Kona', 3790, 'hawaii'), place('LIH', 'Kauai', 3930, 'hawaii'),
    place('YVR', 'Vancouver', 1285, 'canada'), place('YYC', 'Calgary', 1640, 'canada'), place('YYZ', 'Toronto', 3630, 'canada'),
    place('YUL', 'Montreal', 4090, 'canada'), place('MEX', 'Mexico City', 3030, 'latin'), place('GDL', 'Guadalajara', 2640, 'latin'),
    place('CUN', 'Cancun', 3880, 'latin'), place('PVR', 'Puerto Vallarta', 2460, 'latin'), place('SJD', 'Los Cabos', 2010, 'latin'),
    place('SAL', 'San Salvador', 3900, 'latin'), place('PTY', 'Panama City', 5390, 'latin'), place('BOG', 'Bogota', 6130, 'latin'),
    place('LHR', 'London', 8620, 'europe'), place('CDG', 'Paris', 8970, 'europe'), place('FRA', 'Frankfurt', 9150, 'europe'),
    place('MUC', 'Munich', 9450, 'europe'), place('AMS', 'Amsterdam', 8800, 'europe'), place('ZRH', 'Zurich', 9390, 'europe'),
    place('DUB', 'Dublin', 8200, 'europe'), place('MAD', 'Madrid', 9340, 'europe'), place('LIS', 'Lisbon', 9130, 'europe'),
    place('FCO', 'Rome', 10070, 'europe'), place('IST', 'Istanbul', 10800, 'europe'),
    place('DXB', 'Dubai', 13040, 'gulf'), place('DOH', 'Doha', 13000, 'gulf'), place('DEL', 'Delhi', 12380, 'gulf'),
    place('BLR', 'Bengaluru', 14000, 'gulf'), place('TLV', 'Tel Aviv', 11950, 'gulf'),
    place('NRT', 'Tokyo Narita', 8220, 'asia'), place('HND', 'Tokyo Haneda', 8280, 'asia'), place('KIX', 'Osaka', 8690, 'asia'),
    place('ICN', 'Seoul', 9060, 'asia'), place('PEK', 'Beijing', 9520, 'asia'), place('PVG', 'Shanghai', 9870, 'asia'),
    place('HKG', 'Hong Kong', 11110, 'asia'), place('TPE', 'Taipei', 10370, 'asia'), place('MNL', 'Manila', 11220, 'asia'),
    place('SIN', 'Singapore', 13590, 'asia'), place('SGN', 'Ho Chi Minh City', 12600, 'asia'),
    place('SYD', 'Sydney', 11940, 'oceania'), place('MEL', 'Melbourne', 12640, 'oceania'), place('AKL', 'Auckland', 10480, 'oceania'),
    place('NAN', 'Nadi', 8830, 'oceania'), place('PPT', 'Papeete', 6760, 'oceania'),
  ].map((d) => [d.code, d]),
);

/**
 * When flights to and from a region usually leave and land at SFO, as [start hour, end hour,
 * weight] windows on the local clock. A window may run past midnight (end > 24).
 */
export const BANKS: Record<Region, { departures: [number, number, number][]; arrivals: [number, number, number][] }> = {
  west: { departures: [[5.75, 9.5, 3], [9.5, 16, 4], [16, 22.5, 4]], arrivals: [[7, 11, 3], [11, 17, 4], [17, 23.75, 5]] },
  mountain: { departures: [[6, 9.5, 3], [10, 15, 3], [15.5, 21, 3]], arrivals: [[8, 12, 3], [12, 18, 3], [18, 23.5, 4]] },
  central: { departures: [[5.75, 9, 4], [10, 14.5, 3], [15, 18, 2], [22.5, 24.4, 1]], arrivals: [[9, 13, 3], [13, 19, 3], [19, 23.75, 4]] },
  east: { departures: [[5.75, 9, 4], [10, 14, 3], [14, 16.5, 1], [21.5, 24.5, 3]], arrivals: [[9.5, 13, 3], [13, 19, 3], [19, 24.3, 5]] },
  hawaii: { departures: [[8, 13, 4], [16.5, 19, 1]], arrivals: [[5, 7.5, 2], [13, 16, 1], [19.5, 23.5, 4]] },
  canada: { departures: [[6, 10, 2], [11, 15, 2], [16, 21, 2]], arrivals: [[9, 13, 2], [14, 18, 2], [19, 23.5, 2]] },
  latin: { departures: [[7, 12.5, 3], [23, 25.5, 2]], arrivals: [[5.5, 8, 1], [12.5, 15.5, 2], [18.5, 22.5, 3]] },
  europe: { departures: [[12.5, 16, 3], [16, 20.5, 4]], arrivals: [[10.5, 14, 3], [14, 18.5, 4]] },
  gulf: { departures: [[15.5, 18, 2], [20.5, 22.5, 1]], arrivals: [[12, 15, 2], [17, 19.5, 1]] },
  asia: { departures: [[10.5, 14.5, 5], [22.5, 25.5, 4]], arrivals: [[7.5, 11.5, 5], [16, 20, 3]] },
  oceania: { departures: [[21.5, 24.2, 3]], arrivals: [[6, 10, 2], [13, 15.5, 1]] },
};

export interface Airline {
  code: string;
  name: string;
  /** Tail colour and a second colour for trim, sRGB hex. */
  colour: number;
  accent: number;
  /** Share of the day's flights. */
  share: number;
  /** Boarding areas in order of preference, for domestic and for international flights. */
  areas: string[];
  internationalAreas: string[];
  /** [type, weight] for short and medium flights, and for long-haul. */
  fleet: [string, number][];
  longHaul: [string, number][];
  destinations: string[];
  /** Share of passengers connecting to another flight here. */
  connecting: number;
}

const D = (codes: string): string[] => codes.split(' ');

export const AIRLINES: Airline[] = [
  {
    code: 'UA', name: 'United', colour: 0x0b3d91, accent: 0x7fb6ff, share: 0.44, areas: ['F', 'E'], internationalAreas: ['G', 'F'],
    fleet: [['E75L', 26], ['A320', 22], ['B738', 20], ['B39M', 16], ['A21N', 8], ['B752', 5], ['B789', 3]],
    longHaul: [['B789', 5], ['B77W', 4]],
    destinations: D('LAX SAN LAS SEA PDX SNA BUR PSP RNO SBA EUG MFR FAT ACV RDM GEG BOI SLC PHX TUS DEN ABQ BZN JAC DFW IAH AUS ORD MSP STL MCI BNA MSY DTW ATL MIA MCO CLT IAD DCA PHL EWR BOS RDU TPA FLL PIT CLE HNL OGG KOA LIH YVR YYC YYZ MEX CUN PVR SJD LHR CDG FRA MUC AMS ZRH DUB FCO DEL BLR TLV NRT HND KIX ICN PEK PVG HKG TPE MNL SIN SYD MEL AKL PPT'),
    connecting: 0.3,
  },
  {
    code: 'AS', name: 'Alaska', colour: 0x01426a, accent: 0x48a9c5, share: 0.11, areas: ['D', 'B'], internationalAreas: ['D', 'A'],
    fleet: [['B738', 30], ['B39M', 28], ['E75L', 26], ['A21N', 8]], longHaul: [['B39M', 1]],
    destinations: D('SEA PDX LAX SAN SNA BUR PSP LAS PHX SLC BOI GEG RDM EUG DEN AUS ORD JFK EWR BOS IAD DCA MCO HNL OGG KOA LIH PVR SJD CUN YVR'),
    connecting: 0.12,
  },
  {
    code: 'DL', name: 'Delta', colour: 0x9b1c31, accent: 0x1b2f5b, share: 0.09, areas: ['C'], internationalAreas: ['C', 'A'],
    fleet: [['A320', 22], ['A21N', 26], ['B738', 20], ['BCS3', 22], ['E75L', 10], ['B752', 8]], longHaul: [['B752', 1]],
    destinations: D('ATL MSP DTW SLC SEA LAX JFK BOS LAS SAN PDX AUS RDU'),
    connecting: 0.05,
  },
  {
    code: 'AA', name: 'American', colour: 0x8a97a6, accent: 0xb22234, share: 0.07, areas: ['B'], internationalAreas: ['B', 'A'],
    fleet: [['A21N', 34], ['B738', 34], ['A320', 22], ['E75L', 10]], longHaul: [['B789', 1]],
    destinations: D('DFW ORD CLT MIA PHX PHL JFK LAX DCA AUS'),
    connecting: 0.05,
  },
  {
    code: 'WN', name: 'Southwest', colour: 0x304cb2, accent: 0xffbf27, share: 0.06, areas: ['B'], internationalAreas: ['B'],
    fleet: [['B738', 60], ['B39M', 40]], longHaul: [['B738', 1]],
    destinations: D('LAS SAN LAX BUR SNA PHX DEN MCI STL BNA AUS'),
    connecting: 0.08,
  },
  {
    code: 'B6', name: 'JetBlue', colour: 0x0033a0, accent: 0x8cc8ff, share: 0.028, areas: ['B', 'A'], internationalAreas: ['A'],
    fleet: [['A320', 45], ['A21N', 45], ['BCS3', 10]], longHaul: [['A21N', 1]],
    destinations: D('JFK BOS FLL EWR LAX'),
    connecting: 0.03,
  },
  {
    code: 'F9', name: 'Frontier', colour: 0x2e7d32, accent: 0xd8e8d0, share: 0.016, areas: ['D', 'B'], internationalAreas: ['A'],
    fleet: [['A320', 60], ['A21N', 40]], longHaul: [['A320', 1]],
    destinations: D('DEN LAS PHX SAN SNA ATL'),
    connecting: 0.02,
  },
  {
    code: 'HA', name: 'Hawaiian', colour: 0x5b2c83, accent: 0xe0458b, share: 0.008, areas: ['A', 'D'], internationalAreas: ['A'],
    fleet: [['A21N', 100]], longHaul: [['A21N', 1]], destinations: D('HNL OGG'), connecting: 0.02,
  },
  {
    code: 'AC', name: 'Air Canada', colour: 0xd22630, accent: 0x222222, share: 0.024, areas: ['D', 'G'], internationalAreas: ['D', 'G'],
    fleet: [['A320', 40], ['BCS3', 40], ['B39M', 20]], longHaul: [['B789', 1]],
    destinations: D('YVR YYZ YYC YUL'), connecting: 0.02,
  },
  {
    code: 'WS', name: 'WestJet', colour: 0x00a3ad, accent: 0x1f2a44, share: 0.006, areas: ['A'], internationalAreas: ['A'],
    fleet: [['B738', 100]], longHaul: [['B738', 1]], destinations: D('YYC YVR'), connecting: 0.02,
  },
  ...(
    [
      ['BA', 'British Airways', 0x1c2b5a, 0xc8102e, 0.006, 'A', ['A388', 1, 'B77W', 1], 'LHR'],
      ['VS', 'Virgin Atlantic', 0xb1002d, 0x4b1f6f, 0.003, 'A', ['A359', 1, 'B789', 1], 'LHR'],
      ['LH', 'Lufthansa', 0x0a1d3d, 0xf9ba00, 0.006, 'G', ['A388', 1, 'A359', 2], 'FRA MUC'],
      ['LX', 'Swiss', 0xd52b1e, 0xffffff, 0.003, 'G', ['B77W', 1], 'ZRH'],
      ['AF', 'Air France', 0x002157, 0xe1000f, 0.005, 'A', ['B77W', 2, 'A359', 1], 'CDG'],
      ['KL', 'KLM', 0x00a1e4, 0x003d7c, 0.003, 'A', ['B789', 1], 'AMS'],
      ['EI', 'Aer Lingus', 0x006272, 0x9bc53d, 0.003, 'A', ['A359', 1], 'DUB'],
      ['IB', 'Iberia', 0xd7192d, 0xfcd116, 0.002, 'A', ['A359', 1], 'MAD'],
      ['TP', 'TAP Air Portugal', 0x00a650, 0xe2001a, 0.002, 'G', ['A21N', 1], 'LIS'],
      ['TK', 'Turkish', 0xc70a0c, 0x1a1a1a, 0.003, 'G', ['B77W', 1, 'A359', 1], 'IST'],
      ['EK', 'Emirates', 0xc8102e, 0xb8963e, 0.003, 'A', ['A388', 2, 'B77W', 1], 'DXB'],
      ['QR', 'Qatar Airways', 0x5c0632, 0x9aa0a6, 0.003, 'A', ['A359', 1, 'B77W', 1], 'DOH'],
      ['AI', 'Air India', 0xc8102e, 0xf2a900, 0.003, 'G', ['B77W', 1], 'DEL BLR'],
      ['SQ', 'Singapore Airlines', 0x1d2f5e, 0xf2b434, 0.006, 'G', ['A359', 2, 'B77W', 1], 'SIN HKG'],
      ['CX', 'Cathay Pacific', 0x00645a, 0x9aa0a6, 0.005, 'A', ['A359', 1, 'B77W', 1], 'HKG'],
      ['BR', 'EVA Air', 0x00704a, 0xf58220, 0.006, 'G', ['B77W', 2, 'B789', 1], 'TPE'],
      ['CI', 'China Airlines', 0x7b2d6b, 0xe8a0b8, 0.005, 'A', ['B77W', 1, 'A359', 1], 'TPE'],
      ['JL', 'Japan Airlines', 0xcc0000, 0x222222, 0.005, 'A', ['B77W', 1, 'B789', 1], 'HND NRT'],
      ['NH', 'ANA', 0x13448f, 0x3b9ddd, 0.005, 'G', ['B77W', 1, 'B789', 1], 'NRT HND'],
      ['ZG', 'Zipair', 0x1a1a1a, 0x7ac143, 0.003, 'A', ['B789', 1], 'NRT'],
      ['KE', 'Korean Air', 0x74b5e4, 0x154d9e, 0.005, 'A', ['B77W', 1, 'A388', 1], 'ICN'],
      ['OZ', 'Asiana', 0x8a8d8f, 0xc8102e, 0.003, 'G', ['A359', 1], 'ICN'],
      ['PR', 'Philippine Airlines', 0x0038a8, 0xce1126, 0.005, 'A', ['B77W', 1, 'A359', 1], 'MNL'],
      ['VN', 'Vietnam Airlines', 0x005e80, 0xd4a017, 0.002, 'A', ['B789', 1], 'SGN'],
      ['CA', 'Air China', 0xc8102e, 0x1a1a1a, 0.003, 'G', ['B789', 1, 'B77W', 1], 'PEK'],
      ['MU', 'China Eastern', 0x1b3a8c, 0xc8102e, 0.003, 'A', ['B77W', 1, 'A359', 1], 'PVG'],
      ['QF', 'Qantas', 0xe40000, 0xffffff, 0.003, 'A', ['B789', 1], 'SYD MEL'],
      ['NZ', 'Air New Zealand', 0x1a1a1a, 0x00a79d, 0.003, 'G', ['B789', 1, 'B77W', 1], 'AKL'],
      ['FJ', 'Fiji Airways', 0x4b2e1e, 0xd9a441, 0.002, 'A', ['A359', 1], 'NAN'],
      ['TN', 'Air Tahiti Nui', 0x00a3ad, 0xe0457b, 0.002, 'A', ['B789', 1], 'PPT'],
      ['AM', 'Aeromexico', 0x0b2343, 0xc8102e, 0.005, 'A', ['B738', 2, 'B39M', 1], 'MEX GDL'],
      ['AV', 'Avianca', 0xd0021b, 0xffffff, 0.003, 'A', ['A320', 1], 'SAL BOG'],
      ['CM', 'Copa', 0x003a70, 0x8a8d8f, 0.003, 'A', ['B39M', 1, 'B738', 1], 'PTY'],
    ] as [string, string, number, number, number, string, (string | number)[], string][]
  ).map(([code, name, colour, accent, share, area, types, destinations]): Airline => {
    const fleet: [string, number][] = [];
    for (let i = 0; i < types.length; i += 2) fleet.push([types[i] as string, types[i + 1] as number]);
    return { code, name, colour, accent, share, areas: [area], internationalAreas: [area, area === 'A' ? 'G' : 'A'], fleet, longHaul: fleet, destinations: D(destinations), connecting: 0.04 };
  }),
];

export const AIRLINE_BY_CODE: Record<string, Airline> = Object.fromEntries(AIRLINES.map((a) => [a.code, a]));

/** Flights longer than this use the long-haul fleet. */
export const LONG_HAUL_KM = 5200;
