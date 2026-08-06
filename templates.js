// templates.js — built-in event types (criteria presets), from the workbook's
// library of past contests. Users can also save their own types to Firestore;
// the admin selector merges built-ins + saved types.
//
// Each template: { id, name, category, note?, schedule?, criteria:[{name, shortName, weight, low, high}] }
// weights are fractions that sum to 1.0.

export const BUILTIN_TEMPLATES = [
  {
    id: "bbq-signature",
    name: "BBQ Throwdown — Signature",
    category: "BBQ",
    note: "The classic HouBBQ Throwdown criteria (ingredient-led).",
    schedule: { intervalMin: 5 },
    criteria: [
      { name: "Use of Ingredients", shortName: "Ingredients", weight: 0.30, low: "Basic / Uninspired", high: "Clever / Creative Use" },
      { name: "Flavor", shortName: "Flavor", weight: 0.25, low: "Bland / One-note", high: "Rich, Flavorful and Varied" },
      { name: "Dish Execution", shortName: "Execution", weight: 0.15, low: "Sloppy", high: "Composed and Amazing" },
      { name: "Appearance", shortName: "Appearance", weight: 0.12, low: "Visually Unappealing", high: "Stunning" },
      { name: "Creativity", shortName: "Creativity", weight: 0.10, low: "Could come from anywhere", high: "One of a Kind!" },
      { name: "Texture", shortName: "Texture", weight: 0.08, low: "Tough / Chewy", high: "Tender and Amazing" },
    ],
  },
  {
    id: "bbq-smoke-craft",
    name: "BBQ Throwdown — Smoke & Craft",
    category: "BBQ",
    note: "Smoke-forward variant (weights are a starting point — tune them).",
    schedule: { intervalMin: 5 },
    criteria: [
      { name: "Flavor", shortName: "Flavor", weight: 0.30, low: "Bland / One-Note", high: "Balanced / Flavorful" },
      { name: "Level/Quality of Smoke", shortName: "Smoke", weight: 0.20, low: "No Smoke / Acrid", high: "Balanced Smoke Flavor" },
      { name: "Texture", shortName: "Texture", weight: 0.18, low: "Tough / Chewy", high: "Tender / Creative Textures" },
      { name: "Appearance", shortName: "Appearance", weight: 0.12, low: "Visually Unappealing", high: "Stunning" },
      { name: "Reproducible at Volume", shortName: "Reproducible", weight: 0.10, low: "Tweezer food — hard to make", high: "Easily produced by a pitmaster" },
      { name: "Uniqueness to Houston", shortName: "Uniqueness", weight: 0.10, low: "Could come from anywhere", high: "A one-of-a-kind dish" },
    ],
  },
  {
    id: "truffle-masters",
    name: "Truffle Masters",
    category: "Themed",
    note: "Single-ingredient showcase.",
    schedule: { intervalMin: 5 },
    criteria: [
      { name: "Use of Fresh Truffle", shortName: "Truffle", weight: 0.30, low: "Little to No Truffle", high: "Loaded with Truffle" },
      { name: "Flavor", shortName: "Flavor", weight: 0.25, low: "Bland / One-note", high: "Rich, Flavorful and Varied" },
      { name: "Dish Execution", shortName: "Execution", weight: 0.15, low: "Sloppy", high: "Composed and Amazing" },
      { name: "Appearance", shortName: "Appearance", weight: 0.12, low: "Visually Unappealing", high: "Stunning" },
      { name: "Creativity", shortName: "Creativity", weight: 0.10, low: "Could come from anywhere", high: "One of a Kind!" },
      { name: "Texture", shortName: "Texture", weight: 0.08, low: "Tough / Chewy", high: "Tender and Amazing" },
    ],
  },
  {
    id: "food-wine-week",
    name: "Food & Wine Week",
    category: "General",
    note: "General culinary competition.",
    schedule: { intervalMin: 5 },
    criteria: [
      { name: "Use of Ingredients", shortName: "Ingredients", weight: 0.30, low: "Basic / Uninspired", high: "Clever / Creative Use" },
      { name: "Flavor", shortName: "Flavor", weight: 0.25, low: "Bland / One-note", high: "Rich, Flavorful and Varied" },
      { name: "Dish Execution", shortName: "Execution", weight: 0.15, low: "Sloppy", high: "Composed and Amazing" },
      { name: "Appearance", shortName: "Appearance", weight: 0.12, low: "Visually Unappealing", high: "Stunning" },
      { name: "Creativity", shortName: "Creativity", weight: 0.10, low: "Could come from anywhere", high: "One of a Kind!" },
      { name: "Texture", shortName: "Texture", weight: 0.08, low: "Tough / Chewy", high: "Tender and Amazing" },
    ],
  },
  {
    id: "generic-tasting",
    name: "Generic Tasting (5 equal)",
    category: "General",
    note: "Simple, balanced starter for any food event.",
    schedule: { intervalMin: 5 },
    criteria: [
      { name: "Flavor", shortName: "Flavor", weight: 0.30, low: "Off / unbalanced", high: "Delicious, well-balanced" },
      { name: "Presentation", shortName: "Presentation", weight: 0.20, low: "Messy", high: "Beautiful" },
      { name: "Creativity", shortName: "Creativity", weight: 0.20, low: "Predictable", high: "Inventive" },
      { name: "Execution", shortName: "Execution", weight: 0.20, low: "Sloppy", high: "Flawless" },
      { name: "Overall Impression", shortName: "Overall", weight: 0.10, low: "Forgettable", high: "Would seek out again" },
    ],
  },
];

// criteria with fresh ids (so an applied template's ids don't collide across events)
export function templateCriteria(tpl, uid) {
  return (tpl.criteria || []).map((c) => ({
    id: uid("c"),
    name: c.name,
    shortName: c.shortName || c.name,
    weight: c.weight,
    low: c.low || "",
    high: c.high || "",
  }));
}
