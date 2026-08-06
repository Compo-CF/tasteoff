// seed-houbbq.js — writes the HouBBQ Throwdown 2026 event to Firestore.
// Single source of truth for the data is sample-event.js.
import { saveEvent } from "./firebase.js";
import { makeSampleEvent } from "./sample-event.js";

export async function seed() {
  const ev = makeSampleEvent("houbbq-2026");
  const { id, ...data } = ev;
  await saveEvent(id, { ...data, id });
  return id;
}
