import { MODULE_ID, log, warn, registerPatch } from "../utils/patch-helper.mjs";

/**
 * Active effect icons on tokens.
 *
 * Foundry v14 decides what the token draws from `ActiveEffect#showIcon`
 * (`common/documents/active-effect.mjs:73`, values in `common/constants.mjs:165`):
 *   0 NEVER - never drawn, 1 CONDITIONAL - drawn while the effect is temporary, 2 ALWAYS - always drawn.
 * `Token#_drawEffects` (`client/canvas/placeables/token.mjs:1870`) keeps only ALWAYS and
 * CONDITIONAL-and-temporary effects, and the schema default is CONDITIONAL.
 *
 * The defect: worlds migrated away from DAE mapped the deprecated `flags.dae.showIcon` as
 * `true -> 2 / false -> 0`. The DAE flag only ever forced an icon ON - the module's own migration
 * (`modules/dae/module/dae.js:1856`) writes showIcon 2 for a truthy flag and leaves a falsy one untouched -
 * so `false` meant "core default", not "never". Every effect that carried the falsy flag was silenced, and
 * so is every applied copy made from it afterwards, because the applied effect inherits the field from its
 * template (the reported "Щит веры" on Actor.GCumrX0d8QDRaaSD).
 *
 * 1. Repair: one pass over the world turning showIcon NEVER back into CONDITIONAL. Idempotent, runs once
 *    per world (tracked by a hidden world setting), re-runnable from the API below.
 * 2. Optional display rule: a world setting that also draws applied (non-transferred) effects which have no
 *    duration. Off by default, because the core meaning of CONDITIONAL is "temporary effects only".
 */

const SHOW_ICON = { NEVER: 0, CONDITIONAL: 1, ALWAYS: 2 };

/** Bumped when the repair has to run again over worlds it already visited. */
const REPAIR_VERSION = 1;
const REPAIR_SETTING = "effectIconRepair";
const ALL_APPLIED_SETTING = "showAllAppliedEffectIcons";

export function initEffectIcons() {
  log("Initializing Effect Icons (showIcon repair)...");

  game.settings.register(MODULE_ID, REPAIR_SETTING, {
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, ALL_APPLIED_SETTING, {
    name: "DND5ECP.Settings.ShowAllApplied.Name",
    hint: "DND5ECP.Settings.ShowAllApplied.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: false,
    onChange: () => redrawTokenEffects()
  });

  // The optional rule is applied where the core filters the effects, so nothing about the data changes.
  // Registered on "setup": the system swaps CONFIG.Token.objectClass for its own subclass inside its own
  // "init" hook (dnd5e.mjs:82401), and this has to wrap whatever class ends up there.
  Hooks.once("setup", () => registerPatch("CONFIG.Token.objectClass.prototype._drawEffects", async function (wrapped, ...args) {
    if (!game.settings.get(MODULE_ID, ALL_APPLIED_SETTING)) return wrapped(...args);
    const actor = this.actor;
    if (!actor) return wrapped(...args);
    // `isTemporary` is a getter on the effect; overriding it for the duration of the core call is the least
    // invasive way to widen the filter without copying _drawEffects itself.
    const patched = [];
    for (const effect of actor.appliedEffects ?? []) {
      if (effect.transfer) continue;
      if (effect.showIcon !== SHOW_ICON.CONDITIONAL) continue;
      if (effect.isTemporary) continue;
      Object.defineProperty(effect, "isTemporary", { value: true, configurable: true });
      patched.push(effect);
    }
    try {
      return await wrapped(...args);
    } finally {
      for (const effect of patched) delete effect.isTemporary;
    }
  }));

  Hooks.once("ready", async () => {
    if (!game.user.isGM) return;
    if (game.settings.get(MODULE_ID, REPAIR_SETTING) >= REPAIR_VERSION) return;
    const result = await repairEffectIcons({ dryRun: false });
    await game.settings.set(MODULE_ID, REPAIR_SETTING, REPAIR_VERSION);
    if (result.repaired) {
      ui.notifications.info(game.i18n.format("DND5ECP.EffectIcons.Repaired", { count: result.repaired }));
    }
  });

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api ??= {};
    module.api.repairEffectIcons = repairEffectIcons;
  }
}

/* -------------------------------------------- */

/**
 * Turn every `showIcon: NEVER` in the world back into the schema default, CONDITIONAL.
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true]  Only count what would change.
 * @returns {Promise<{repaired: number, documents: string[]}>}
 */
export async function repairEffectIcons({ dryRun = true } = {}) {
  const documents = [];
  let repaired = 0;

  const collect = parent => {
    const updates = [];
    for (const effect of parent.effects ?? []) {
      if (effect._source?.showIcon !== SHOW_ICON.NEVER) continue;
      updates.push({ _id: effect.id, showIcon: SHOW_ICON.CONDITIONAL });
    }
    return updates;
  };

  const apply = async (parent, updates) => {
    if (!updates.length) return;
    repaired += updates.length;
    documents.push(`${parent.documentName} "${parent.name}" (${updates.length})`);
    if (dryRun) return;
    try {
      await parent.updateEmbeddedDocuments("ActiveEffect", updates, { render: false });
    } catch (err) {
      warn(`Could not repair effect icons on ${parent.uuid}:`, err);
    }
  };

  const walkActor = async actor => {
    await apply(actor, collect(actor));
    for (const item of actor.items ?? []) await apply(item, collect(item));
  };

  for (const actor of game.actors ?? []) await walkActor(actor);
  for (const item of game.items ?? []) await apply(item, collect(item));

  // Unlinked tokens keep their own copies in the ActorDelta; only those are touched, inherited effects
  // already carry the repaired value from the base actor.
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actorLink || !token.actor) continue;
      const source = token.delta?._source ?? {};
      const deltaEffects = new Set((source.effects ?? []).map(e => e?._id).filter(Boolean));
      const deltaItems = new Map((source.items ?? []).map(i => [i?._id, i]).filter(([id]) => id));
      if (deltaEffects.size) {
        await apply(token.actor, collect(token.actor).filter(u => deltaEffects.has(u._id)));
      }
      for (const [itemId] of deltaItems) {
        const item = token.actor.items?.get(itemId);
        if (item) await apply(item, collect(item));
      }
    }
  }

  log(`${dryRun ? "Dry run" : "Repaired"}: ${repaired} effect(s) with showIcon=NEVER`);
  return { repaired, documents };
}

/* -------------------------------------------- */

/** Redraw the effect icons of every token on the active scene. */
function redrawTokenEffects() {
  for (const token of canvas?.tokens?.placeables ?? []) token.renderFlags?.set({ redrawEffects: true });
}
