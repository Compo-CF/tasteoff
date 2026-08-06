// sample-event.js — the HouBBQ Throwdown 2026 event data, pulled from the workbook.
// Shared by the Firestore seed (seed-houbbq.js) and the no-backend demo mode.

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

const startTime = "13:00";
const intervalMin = 5;

const roster = [
  ["23", "Charm Taphouse and BBQ"],
  ["16", "Weaver's BBQ"],
  ["9", "Chicano BBQ"],
  ["21", "Daddy Duncan's BBQ"],
  ["13", "Deckle and Hide"],
  ["3", "Eastbound Barbecue"],
  ["34", "Fire Craft BBQ"],
  ["32", "Koop's BBQ Kitchen"],
  ["31", "La Cruda Brand BBQ"],
  ["10", "Space City BBQ"],
  ["20", "The Pit Room"],
  ["29", "The Station and Smokey Oaks"],
  ["7", "Chavo's BBQ"],
];

export function makeSampleEvent(id = "houbbq-2026") {
  return {
    id,
    name: "HouBBQ Throwdown 2026",
    // Active criteria + weights from the workbook (Places, Judges, Coding!C48:K54).
    criteria: [
      { id: "c_ingredients", name: "Use of Ingredients", shortName: "Ingredients", weight: 0.30, low: "Basic / Uninspired", high: "Clever / Creative Use" },
      { id: "c_flavor", name: "Flavor", shortName: "Flavor", weight: 0.25, low: "Bland / One-note", high: "Rich, Flavorful and Varied" },
      { id: "c_execution", name: "Dish Execution", shortName: "Execution", weight: 0.15, low: "Sloppy", high: "Composed and Amazing" },
      { id: "c_appearance", name: "Appearance", shortName: "Appearance", weight: 0.12, low: "Visually Unappealing", high: "Stunning" },
      { id: "c_creativity", name: "Creativity", shortName: "Creativity", weight: 0.10, low: "Could come from anywhere", high: "One of a Kind!" },
      { id: "c_texture", name: "Texture", shortName: "Texture", weight: 0.08, low: "Tough / Chewy", high: "Tender and Amazing" },
    ],
    // Table A judges from the workbook (Places, Judges, Coding!L4:L8).
    judges: [
      { id: "j_buckman", name: "Buckman", table: "A" },
      { id: "j_mueller", name: "Mueller", table: "A" },
      { id: "j_ong", name: "Ong", table: "A" },
      { id: "j_timmonsw", name: "Timmonsw", table: "A" },
      { id: "j_kelly", name: "Kelly", table: "A" },
    ],
    teams: roster.map(([code, name], i) => ({
      code,
      name,
      table: "A",
      dishNumber: i + 1,
      serveTime: addMinutes(startTime, i * intervalMin),
      dishDescription: "",
    })),
    schedule: { startTime, intervalMin },
    adminPasscode: "",
    resultsPasscode: "",
    awards: { judgesTopN: 3, peoples: { enabled: true, unit: "Coins", topN: 2 } },
  };
}

export const SAMPLE_EVENT = makeSampleEvent("houbbq-2026");
