/**
 * Repair dangling embedded-item ids left behind in advancement records.
 *
 * WHAT IT FIXES
 * A class, subclass or feat records what each of its advancements granted, by the LOCAL id of the item it made:
 *   system.advancement.<advId>.value.added[<level>][<itemId>]      = "<source uuid>"
 *   system.advancement.<advId>.value.replaced[<level>]             = { level, original: "<itemId>", replacement: "<itemId>" }
 * Those are hand-kept id -> id links, not document references, so deleting the granted item - from the sheet, by
 * a module, by a half-finished level-down - leaves the id behind. When the advancement is next reversed, dnd5e
 * asks the server to delete an item that is not there and the log fills with
 * `Item "<id>" does not exist!` (one line per attempt, and the flows retry).
 *
 * WHAT IT DOES
 * Drops exactly those entries whose item is gone from the actor, and nothing else:
 *   - `added[<level>][<id>]`, and the level key with it when it empties;
 *   - `replaced[<level>]` when its `original` or `replacement` is gone (the record is only meaningful as a pair).
 *
 * USAGE (FOUNDRY MUST BE CLOSED - the server holds these LevelDBs open and a second writer corrupts them):
 *   node repair-advancement-ids.mjs <path to a world>            # dry run, prints what it would change
 *   node repair-advancement-ids.mjs <path to a world> --apply    # writes, after copying the actors db to
 *                                                                # <world>/_backup-actors-<date>
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/mnt/win-data/Backups/FoundryData/foundryvtt/node_modules/");
const { ClassicLevel } = require("classic-level");

const WORLD = process.argv[2];
const APPLY = process.argv.includes("--apply");
if ( !WORLD || !fs.existsSync(path.join(WORLD, "data", "actors")) ) {
  console.error("usage: node repair-advancement-ids.mjs <path to a world> [--apply]");
  process.exit(2);
}
const ACTORS = path.join(WORLD, "data", "actors");

if ( APPLY ) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  // Beside `data/`, never inside it: Foundry opens only the collection folders it knows, but a world's data
  // directory is not a place to leave anything it did not put there.
  const backup = path.join(WORLD, `_backup-actors-${stamp}`);
  if ( !fs.existsSync(backup) ) {
    fs.cpSync(ACTORS, backup, { recursive: true });
    console.log("backup:", backup);
  } else console.log("backup already present:", backup);
}

const db = new ClassicLevel(ACTORS, { valueEncoding: "json" });
await db.open();

// 1. Which embedded items each actor actually has.
const itemsOf = new Map();
const names = new Map();
for await ( const [key, value] of db.iterator() ) {
  if ( key.startsWith("!actors!") ) names.set(key.slice(8), value.name);
  else if ( key.startsWith("!actors.items!") ) {
    const [actorId, itemId] = key.slice(14).split(".");
    if ( !itemsOf.has(actorId) ) itemsOf.set(actorId, new Set());
    itemsOf.get(actorId).add(itemId);
  }
}

// 2. Rewrite the records that name an item the actor does not have.
let changedDocs = 0, changedRefs = 0;
for await ( const [key, item] of db.iterator() ) {
  if ( !key.startsWith("!actors.items!") ) continue;
  const [actorId] = key.slice(14).split(".");
  const has = itemsOf.get(actorId) ?? new Set();
  const advancement = item.system?.advancement;
  if ( !advancement || (typeof advancement !== "object") ) continue;
  let touched = false;

  for ( const [advId, adv] of Object.entries(advancement) ) {
    const added = adv.value?.added;
    if ( added && (typeof added === "object") ) for ( const [level, grants] of Object.entries(added) ) {
      if ( !grants || (typeof grants !== "object") ) continue;
      for ( const id of Object.keys(grants) ) {
        if ( has.has(id) ) continue;
        console.log(`${names.get(actorId)} [${actorId}] ${item.type} ${JSON.stringify(item.name)}`
          + ` :: ${advId}.value.added.${level}.${id} -> ${grants[id]}`);
        delete grants[id];
        touched = true; changedRefs++;
      }
      if ( !Object.keys(grants).length ) delete added[level];
    }
    const replaced = adv.value?.replaced;
    if ( replaced && (typeof replaced === "object") ) for ( const [level, record] of Object.entries(replaced) ) {
      const gone = ["original", "replacement"].filter(k => record?.[k] && !has.has(record[k]));
      if ( !gone.length ) continue;
      console.log(`${names.get(actorId)} [${actorId}] ${item.type} ${JSON.stringify(item.name)}`
        + ` :: ${advId}.value.replaced.${level} (${gone.map(k => `${k}=${record[k]}`).join(", ")} gone)`);
      delete replaced[level];
      touched = true; changedRefs += gone.length;
    }
  }
  if ( !touched ) continue;
  changedDocs++;
  if ( APPLY ) await db.put(key, item);
}
await db.close();
console.log(`${APPLY ? "repaired" : "would repair"}: ${changedRefs} references in ${changedDocs} items`);
if ( !APPLY && changedRefs ) console.log("re-run with --apply (with Foundry closed) to write the changes");
