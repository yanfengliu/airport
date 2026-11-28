/** Synthetic concession stocking and pricing assumptions, in units of one meal or retail item. */
export const CONCESSION_CONFIG = {
  food: { minCapacity: 60, maxCapacity: 320, unitsPerSquareMetre: 1.4, dollars: [8, 28] },
  shop: { minCapacity: 40, maxCapacity: 180, unitsPerSquareMetre: 0.9, dollars: [12, 90] },
  /** Share of shelf capacity handed over when a simulation starts during a day's trading. */
  openingFill: [0.55, 0.95],
  /** Each concourse receives one bounded load on these local clock hours, including a pre-opening run. */
  deliveryHours: [4.5, 7.5, 10.5, 13.5, 16.5, 19.5, 22.5],
  unitsPerLoad: 300,
  retailPurchaseChance: 0.35,
} as const;
