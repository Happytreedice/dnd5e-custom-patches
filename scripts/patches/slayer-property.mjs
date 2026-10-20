import { MODULE_ID, log } from "../utils/patch-helper.mjs";

/**
 * Slayer weapon property.
 */
export function initSlayerProperty() {
  log("Initializing Slayer Weapon Property...");

  // 1. Register property in CONFIG.DND5E
  if (CONFIG.DND5E) {
    CONFIG.DND5E.itemProperties ??= {};
    CONFIG.DND5E.itemProperties.slayer = {
      label: "DND5E.ITEM.Property.Slayer"
    };

    CONFIG.DND5E.validProperties ??= {};
    CONFIG.DND5E.validProperties.weapon ??= new Set();
    CONFIG.DND5E.validProperties.weapon.add("slayer");
  }

  // 2. Inject Slayer config into weapon sheet
  Hooks.on("renderItemSheet5e", async (sheet, html, data) => {
    if (sheet.item.type !== "weapon") return;
    const root = html instanceof HTMLElement ? html : html[0];
    if (!root) return;

    const properties = sheet.item.system?.properties;
    const hasSlayer = properties?.has ? properties.has("slayer") : properties?.includes?.("slayer");
    if (!hasSlayer) return;

    // 5.3.3 details tab: <section class="details tab" data-tab="details"> (templates/items/details.hbs:1). The
    // earlier "tabs" part (item-sheet.mjs:59-62) renders <nav><a data-action="tab" data-tab="details"> first in DOM
    // order (Foundry templates/generic/tab-navigation.hbs:4), and querySelector with a selector list returns the first
    // match of ANY selector, so a bare [data-tab="details"] would pick the nav link; exclude nav descendants.
    const detailsTab = root.querySelector('section.tab.details, .tab.details, [data-tab="details"]:not(nav *)');
    if (!detailsTab || detailsTab.querySelector(".weapon-slayer-config")) return;

    // Stored in this module's flags; the inputs are named flags.<module>.slayer.* so the item sheet's own
    // submitOnChange form handling persists them (system.slayer does not exist in the dnd5e schema).
    const slayer = sheet.item.flags?.[MODULE_ID]?.slayer ?? { type: "", formula: "" };

    const templateData = {
      hasSlayer: true,
      slayer,
      creatureTypes: CONFIG.DND5E?.creatureTypes ?? {}
    };

    const render = foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
    const rendered = await render(`modules/${MODULE_ID}/templates/items/details-weapon-slayer.hbs`, templateData);
    const div = document.createElement("div");
    div.className = "weapon-slayer-config";
    div.innerHTML = rendered;
    detailsTab.appendChild(div);
  });

  /**
   * Does the targeted actor match the configured slayer creature type?
   * 5.3.3 stores the creature type at system.details.type = {value, subtype, swarm, custom} for NPCs
   * (module/data/actor/npc.mjs:89, module/data/shared/creature-type-field.mjs) and characters copy it from their
   * species item in prepareDerivedData (module/data/actor/character.mjs:203). `value` is a CONFIG.DND5E.creatureTypes
   * key, `subtype`/`custom` are free text.
   * @param {Actor} actor
   * @param {string} slayerType  Key of CONFIG.DND5E.creatureTypes (or free text) configured on the weapon.
   * @returns {boolean}
   */
  const matchesCreatureType = (actor, slayerType) => {
    const type = actor?.system?.details?.type;
    if (!type || !slayerType) return false;
    const wanted = String(slayerType).toLowerCase();
    if (String(type.value ?? "").toLowerCase() === wanted) return true;
    const label = game.i18n.localize(CONFIG.DND5E?.creatureTypes?.[slayerType]?.label ?? "").toLowerCase();
    return [type.subtype, type.custom].filter(Boolean).some(text => {
      const lower = String(text).toLowerCase();
      return lower.includes(wanted) || (label && lower.includes(label));
    });
  };

  // 3. Append bonus damage when a targeted creature matches the slayer type.
  // dnd5e 5.3.3 (module/dice/basic-roll.mjs:102-103) calls Hooks.call("dnd5e.preRollDamage", rollConfig, dialogConfig,
  // messageConfig) and "dnd5e.preRollDamageV2" with the same arguments; rollConfig.subject is the Activity
  // (module/documents/activity/mixin.mjs:872) and rollConfig.rolls is an array of {parts, data, options}. The former
  // (activity, rollConfig, dialogConfig) signature never matched. Only the V2 hook is used so the bonus is not added twice.
  Hooks.on("dnd5e.preRollDamageV2", (rollConfig, dialogConfig, messageConfig) => {
    const activity = rollConfig?.subject;
    const item = activity?.item;
    if (item?.type !== "weapon") return;

    const properties = item.system?.properties;
    const hasSlayer = properties?.has ? properties.has("slayer") : properties?.includes?.("slayer");
    if (!hasSlayer) return;

    const slayer = item.flags?.[MODULE_ID]?.slayer;
    if (!slayer?.type || !slayer?.formula) return;

    // Check target token's actor creature type
    const targets = Array.from(game.user.targets);
    const matched = targets.some(target => matchesCreatureType(target.actor, slayer.type));
    if (!matched) return;

    rollConfig.rolls ??= [];
    const base = rollConfig.rolls[0]?.options ?? {};
    rollConfig.rolls.push({
      parts: [slayer.formula],
      data: item.getRollData(),
      options: {
        // Same shape as base-activity.mjs _processDamagePart: inherit the weapon's damage type and physical properties
        type: base.type ?? null,
        types: base.type ? [base.type] : [],
        properties: Array.from(base.properties ?? []),
        flavor: `${game.i18n.localize("DND5E.ITEM.Property.Slayer")}: ${game.i18n.localize(CONFIG.DND5E?.creatureTypes?.[slayer.type]?.label ?? slayer.type)}`
      }
    });
  });
}
