// Downloads the official Backdoors & Breaches card data + art for the bundled decks
// into assets/decks/<Deck>/ so the app runs fully offline afterwards.
//
// Source: the official B&B "Engine-V1" web app (cards are Creative Commons, BHIS).
//   https://play.backdoorsandbreaches.com/play.backdoorsandbreaches.com-Engine-V1/App/
//
// Each deck has decks/<Deck>/carddb.json = { title, revdate, link, data[], red, yellow,
// brown, purple, grey, green, logo }. data[] = { name, image, type, id, details }.
// `image` and the back/logo fields are paths relative to the App/ root.

import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT =
  "https://play.backdoorsandbreaches.com/play.backdoorsandbreaches.com-Engine-V1/App";

// Decks bundled with the app (per design): Core v3.1 + Core v2.2 Expansion.
const DECKS = ["CoreV3.1", "CoreV2.2-Expansion"];

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, "..", "assets");

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Download a path that is relative to the App/ root into assets/<sameRelativePath>,
// skipping files already present. Returns true if it downloaded, false if skipped.
async function downloadAsset(relPath) {
  if (!relPath) return false;
  const dest = join(ASSETS, relPath);
  if (await exists(dest)) return false;
  const buf = await fetchBuffer(`${APP_ROOT}/${relPath}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return true;
}

async function fetchDeck(deck) {
  const carddbRel = `decks/${deck}/carddb.json`;
  console.log(`\n=== ${deck} ===`);
  const jsonBuf = await fetchBuffer(`${APP_ROOT}/${carddbRel}`);
  const db = JSON.parse(jsonBuf.toString("utf8"));

  // Save the card db itself.
  const dbDest = join(ASSETS, carddbRel);
  await mkdir(dirname(dbDest), { recursive: true });
  await writeFile(dbDest, jsonBuf);

  // Collect every image path the deck references: per-card art + the back/logo images.
  const backFields = ["red", "yellow", "brown", "purple", "grey", "green", "logo"];
  const images = new Set();
  for (const card of db.data) if (card.image) images.add(card.image);
  for (const f of backFields) if (db[f]) images.add(db[f]);

  let done = 0;
  let downloaded = 0;
  for (const img of images) {
    try {
      if (await downloadAsset(img)) downloaded++;
    } catch (e) {
      console.warn(`  ! failed ${img}: ${e.message}`);
    }
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${images.size} images...`);
  }
  console.log(
    `  ${deck}: ${db.data.length} cards, ${images.size} images (${downloaded} new, ${
      images.size - downloaded
    } cached)`
  );
}

async function main() {
  await mkdir(ASSETS, { recursive: true });
  for (const deck of DECKS) await fetchDeck(deck);
  console.log("\nDone. Card assets are in assets/decks/.");
}

main().catch((e) => {
  console.error("fetch-cards failed:", e);
  process.exit(1);
});
