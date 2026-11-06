import { MODULE_ID, log } from "../utils/patch-helper.mjs";

/**
 * Spells that always get the weapon block, found by their `system.identifier` (the slug of the English name in dnd5e
 * and in the happytreedice-5etools compendium). The `weaponDamage` property is set by hand on a spell's sheet and is
 * lost whenever the spell is replaced by a fresh copy from a compendium (the actor's Green-Flame Blade and Booming
 * Blade stopped working after such a replacement), so these two do not depend on it.
 */
const DEFAULT_WEAPON_DAMAGE_SPELLS = new Set(["booming-blade", "green-flame-blade"]);

/**
 * Does this spell offer the weapon block? True with the `weaponDamage` property or for a default spell above.
 * @param {Item5e|null|undefined} item
 * @returns {boolean}
 */
export function hasWeaponDamage(item) {
  if (item?.type !== "spell") return false;
  return !!item.system?.properties?.has?.("weaponDamage") || DEFAULT_WEAPON_DAMAGE_SPELLS.has(item.system?.identifier);
}

/**
 * Chat-card block for spells with the `weaponDamage` property (Green-Flame Blade, Booming Blade, …): a dropdown of the
 * caster's equipped weapons with the first one pre-selected, plus Attack and Damage buttons that roll with the chosen
 * weapon; Damage adds the spell's own damage parts after the weapon's.
 */
class WeaponDamageApplicationElement extends HTMLElement {
  static tagName = "weapon-damage-application";

  #message;
  #caster;
  /** Weapon picked on this client, used when the choice cannot be saved on the message (not GM, not the author). */
  #localChoice = null;

  connectedCallback() {
    // The message id lives on the <li class="chat-message" data-message-id> wrapper (Foundry
    // templates/sidebar/chat-message.hbs:1), not on dnd5e's <div class="chat-card"> (templates/chat/activity-card.hbs:1).
    const messageId = this.closest("[data-message-id]")?.dataset?.messageId;
    this.#message = game.messages.get(messageId);
    // ChatMessage5e#getAssociatedActor (module/documents/chat-message.mjs:972) resolves token speakers too
    this.#caster = this.#message?.getAssociatedActor?.()
      ?? (this.#message ? ChatMessage.getSpeakerActor(this.#message.speaker) : null);
    this.#render();
  }

  /** UUID of the weapon remembered on the message, if any. */
  get #savedUuid() {
    return this.#message?.flags?.[MODULE_ID]?.weaponDamage?.weapon ?? null;
  }

  /**
   * Weapons offered in the dropdown: the caster's equipped weapons in inventory order; when nothing is equipped, all of
   * the caster's weapons. A weapon remembered on the message stays listed even if it was unequipped afterwards.
   * @returns {Item5e[]}
   */
  #getWeapons() {
    const all = [...(this.#caster?.itemTypes?.weapon ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const equipped = all.filter(w => w.system?.equipped);
    const weapons = equipped.length ? equipped : all;
    const saved = all.find(w => w.uuid === this.#savedUuid);
    if (saved && !weapons.includes(saved)) weapons.push(saved);
    return weapons;
  }

  /**
   * Selected weapon: this client's pick, then the one remembered on the message, then the first in the list.
   * @param {Item5e[]} weapons
   * @returns {Item5e|null}
   */
  #getWeapon(weapons) {
    return weapons.find(w => w.uuid === this.#localChoice)
      ?? weapons.find(w => w.uuid === this.#savedUuid)
      ?? weapons[0] ?? null;
  }

  #render() {
    const weapons = this.#getWeapons();
    const weapon = this.#getWeapon(weapons);
    if (!weapon) {
      const hint = document.createElement("p");
      hint.classList.add("weapon-damage-empty");
      hint.textContent = game.i18n.localize("DND5E.WEAPONDAMAGE.Warning.NoWeapon");
      this.replaceChildren(hint);
      return;
    }

    // Built with DOM calls rather than innerHTML so weapon names and image paths are never parsed as markup
    const row = document.createElement("label");
    row.classList.add("weapon-select");
    const img = document.createElement("img");
    Object.assign(img, { src: weapon.img, alt: "" });
    const select = document.createElement("select");
    select.name = "weapon";
    select.setAttribute("aria-label", game.i18n.localize("DND5E.WEAPONDAMAGE.Select"));
    select.dataset.tooltip = "DND5E.WEAPONDAMAGE.Select";
    for (const w of weapons) select.add(new Option(w.name, w.uuid, false, w === weapon));
    row.append(img, select);

    // data-weapon-damage-action instead of data-action keeps these buttons away from the chat card's action dispatch
    const buttons = document.createElement("div");
    buttons.classList.add("card-buttons");
    buttons.innerHTML = `
      <button type="button" data-weapon-damage-action="attack">
        <i class="fa-solid fa-dice-d20" inert></i> <span>${game.i18n.localize("DND5E.Attack")}</span>
      </button>
      <button type="button" data-weapon-damage-action="damage">
        <i class="fa-solid fa-burst" inert></i> <span>${game.i18n.localize("DND5E.Damage")}</span>
      </button>
    `;
    this.replaceChildren(row, buttons);

    // Keep interaction with the dropdown from reaching the chat card's own listeners (collapsible sections etc.)
    for (const type of ["click", "pointerdown", "change"]) row.addEventListener(type, event => event.stopPropagation());
    select.addEventListener("change", this.#onSelect.bind(this));
    buttons.addEventListener("click", this.#onClick.bind(this));
  }

  async #onSelect(event) {
    this.#localChoice = event.currentTarget.value;
    // Remember the choice on the message for every client (and across reloads) when this user may update it; the update
    // re-renders the message, which rebuilds this element from the flag.
    if (this.#message?.canUserModify?.(game.user, "update")) {
      await this.#message.setFlag(MODULE_ID, "weaponDamage.weapon", this.#localChoice);
    }
    if (this.isConnected) this.#render();
  }

  async #onClick(event) {
    const action = event.target.closest("[data-weapon-damage-action]")?.dataset.weaponDamageAction;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();

    const weapon = this.#getWeapon(this.#getWeapons());
    if (!weapon) {
      ui.notifications.warn("DND5E.WEAPONDAMAGE.Warning.NoWeapon", { localize: true });
      return;
    }
    const attackActivity = weapon.system.activities?.getByType("attack")?.[0];
    if (!attackActivity) {
      ui.notifications.warn("DND5E.WEAPONDAMAGE.Warning.NoAttack", { localize: true });
      return;
    }

    if (action === "attack") await attackActivity.rollAttack({ event });
    // base-activity.mjs getDamageConfig (line 744-752) appends config.rolls after the weapon's own damage parts
    else if (action === "damage") await attackActivity.rollDamage({ event, rolls: this.#getSpellDamageRolls() });
  }

  /**
   * Extra damage the spell adds to the weapon hit.
   * Cantrips (Green-Flame Blade, Booming Blade, …): their own damage parts describe the secondary effect (flames leaping
   * to a second creature, thunder when the target moves), which stays on the spell card's own Damage button; the weapon
   * hit only gains the cantrip dice — none below 5th level, then 1/2/3 dice at 5th/11th/17th (SpellData#scalingIncrease)
   * of the spell's damage type and die (d8 when the part has no die, e.g. a custom "@mod" formula).
   * Leveled spells (smites): all of the spell's damage parts, scaled like the card's own Damage button — the scaling
   * stored on the usage message applied with item.clone({"flags.dnd5e.scaling"}) as Activity#onChatAction does.
   * Prefers the activity that produced the card.
   * @returns {object[]}
   */
  #getSpellDamageRolls() {
    // ChatMessage5e has no `item` getter; use getAssociatedItem (module/documents/chat-message.mjs:987)
    let spell = this.#message?.getAssociatedItem?.()
      ?? fromUuidSync(this.#message?.flags?.dnd5e?.item?.uuid ?? "", { strict: false });
    if (!spell) return [];
    const scaling = this.#message.system?.scaling;
    if (scaling && (spell.system?.level > 0)) spell = spell.clone({ "flags.dnd5e.scaling": scaling }, { keepId: true });

    const activities = spell.system?.activities;
    const cardActivityId = this.#message.getAssociatedActivity?.()?.id ?? this.#message.flags?.dnd5e?.activity?.id;
    const hasDamage = activity => activity?.damage?.parts?.length > 0;
    const cardActivity = cardActivityId ? activities?.get(cardActivityId) : null;
    const activity = hasDamage(cardActivity) ? cardActivity : activities?.find(hasDamage);

    if (spell.system?.level === 0) {
      const dice = spell.system.scalingIncrease ?? 0;
      if (!(dice > 0)) return [];
      const part = activity?.damage?.parts?.[0];
      const types = Array.from(part?.types ?? []);
      return [{
        data: activity?.getRollData?.() ?? spell.getRollData(),
        parts: [`${dice}d${part?.denomination || 8}`],
        options: { type: types[0], types, properties: [] }
      }];
    }

    return activity ? foundry.utils.deepClone(activity.getDamageConfig().rolls ?? []) : [];
  }
}

/* -------------------------------------------- */
/*  Light source: apply / restore token light   */
/* -------------------------------------------- */

/**
 * Resolve the light-source spell behind an applied effect, if any.
 * dnd5e 5.3.3 applies effects from chat with `origin` = the source effect on the spell item, or the caster's
 * concentration effect (module/applications/components/effect-application.mjs:183-217); the concentration effect
 * records the spell in flags.dnd5e.item.uuid (module/documents/active-effect.mjs:712-713).
 * @param {ActiveEffect} effect
 * @returns {{item: Item, lightConfig: object}|null}
 */
function resolveLightSpell(effect) {
  if (!(effect?.parent instanceof Actor)) return null;
  let item = null;
  const origin = effect.origin ? fromUuidSync(effect.origin, { strict: false }) : null;
  if (origin instanceof Item) item = origin;
  else if (origin instanceof ActiveEffect) {
    if (origin.parent instanceof Item) item = origin.parent;
    else item = fromUuidSync(origin.getFlag("dnd5e", "item.uuid") ?? "", { strict: false });
  } else if (origin?.item instanceof Item) item = origin.item; // an Activity uuid
  if (item?.type !== "spell") return null;

  const properties = item.system?.properties;
  const hasLight = properties?.has ? properties.has("lightSource") : properties?.includes?.("lightSource");
  if (!hasLight) return null;

  const lightConfig = item.flags?.[MODULE_ID]?.light;
  if (!lightConfig) return null;
  return { item, lightConfig };
}

/**
 * Token documents that represent the actor on ANY scene.
 * Actor#getDependentTokens({scenes, linked, concreteOnly}) (Foundry client/documents/actor.mjs:595) returns
 * TokenDocuments from every scene when `scenes` is omitted, and does not depend on the canvas; getActiveTokens
 * (actor.mjs:286) would return [] when the canvas is not ready and only tokens of the viewed scene, so a light
 * that ends while another scene is viewed would never be restored. `concreteOnly` skips ephemeral tokens (the
 * same filter getActiveTokens applies). A synthetic (unlinked) actor is represented by its own token only.
 * @param {Actor} actor
 * @returns {TokenDocument[]}
 */
function lightTokensFor(actor) {
  if (actor.isToken) return actor.token ? [actor.token] : [];
  return actor.getDependentTokens({ linked: true, concreteOnly: true });
}

/**
 * Document hooks fire on every client (Foundry client/data/client-backend.mjs:164/337/466). Exactly one client must
 * update the token: the user who triggered the effect change when they may update the token, otherwise the active GM.
 * @param {string} userId        User who triggered the effect change.
 * @param {TokenDocument} token  Token about to be updated.
 * @returns {boolean}
 */
function isLightResponsibleClient(userId, token) {
  const author = game.users.get(userId);
  const authorCanUpdate = !!author?.active && token.canUserModify(author, "update");
  if (authorCanUpdate) return game.user.id === userId;
  return game.user === game.users.activeGM;
}

/**
 * Value that removes flags.<module>.lightBackup from a token in an update.
 * Foundry v14 provides foundry.data.operators.ForcedDeletion (common/data/operators.mjs:81); the legacy "-=key"
 * syntax still works there but logs a compatibility warning on client and server.
 * @returns {object}
 */
function lightBackupDeletion() {
  const ForcedDeletion = foundry.data?.operators?.ForcedDeletion;
  if (typeof ForcedDeletion === "function") return { lightBackup: new ForcedDeletion() };
  return { "-=lightBackup": null };
}

/**
 * Apply the spell light to the actor's tokens, remembering the previous light in a token flag.
 * @param {ActiveEffect} effect
 * @param {string} userId
 */
async function applySpellLight(effect, userId) {
  const spell = resolveLightSpell(effect);
  if (!spell) return;
  const { lightConfig } = spell;

  for (const token of lightTokensFor(effect.parent)) {
    if (!isLightResponsibleClient(userId, token)) continue;
    const backup = token.getFlag(MODULE_ID, "lightBackup");
    if (backup?.effect === effect.uuid) continue; // already applied for this effect

    await token.update({
      light: {
        dim: Number(lightConfig.dim ?? 40),
        bright: Number(lightConfig.bright ?? 20),
        color: lightConfig.color ?? "#ffeedd",
        // LightData.animation.type is nullable but not blank (common/data/data.mjs:59)
        animation: { type: lightConfig.animation?.type || null }
      },
      flags: {
        [MODULE_ID]: {
          // Keep the light that was there before the FIRST light spell so stacked spells restore the original one;
          // `effect` marks which effect's removal restores it.
          lightBackup: { effect: effect.uuid, light: backup?.light ?? token.light.toObject() }
        }
      }
    });
  }
}

/**
 * Restore the token light saved by applySpellLight when the same effect ends, and clear the backup flag.
 * @param {ActiveEffect} effect
 * @param {string} userId
 */
async function restoreSpellLight(effect, userId) {
  if (!(effect?.parent instanceof Actor)) return;
  for (const token of lightTokensFor(effect.parent)) {
    const backup = token.getFlag(MODULE_ID, "lightBackup");
    if (!backup || backup.effect !== effect.uuid) continue;
    if (!isLightResponsibleClient(userId, token)) continue;
    await token.update({
      light: backup.light,
      flags: { [MODULE_ID]: lightBackupDeletion() }
    });
  }
}

export function initWeaponDamageAndLight() {
  log("Initializing Weapon Damage & Light Source Spell Properties...");

  // Register custom element
  if (!customElements.get(WeaponDamageApplicationElement.tagName)) {
    customElements.define(WeaponDamageApplicationElement.tagName, WeaponDamageApplicationElement);
  }

  // Register properties in CONFIG.DND5E
  if (CONFIG.DND5E) {
    CONFIG.DND5E.itemProperties ??= {};
    CONFIG.DND5E.itemProperties.lightSource = {
      label: "DND5E.ITEM.Property.LightSource",
      icon: "systems/dnd5e/icons/svg/properties/magical.svg"
    };
    CONFIG.DND5E.itemProperties.weaponDamage = {
      label: "DND5E.ITEM.Property.WeaponDamage"
    };

    CONFIG.DND5E.validProperties ??= {};
    CONFIG.DND5E.validProperties.spell ??= new Set();
    CONFIG.DND5E.validProperties.spell.add("lightSource");
    CONFIG.DND5E.validProperties.spell.add("weaponDamage");
  }

  // Inject <weapon-damage-application> into chat cards for weaponDamage spells.
  // Not on core renderChatMessageHTML: ChatMessage5e#renderHTML (module/documents/chat-message.mjs) fires it from
  // super.renderHTML() and only afterwards lets UsageMessageData#getHTML re-render usage-card.hbs into
  // ".message-content", which wipes anything inserted earlier. dnd5e.renderChatMessage fires once dnd5e is done.
  Hooks.on("dnd5e.renderChatMessage", (message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || !message.isContentVisible) return;
    // dnd5e 6.x renders every roll card (attack, damage, save, check, healing) as a ".chat-card" with a ".card-header",
    // and a save rolled from a spell card carries that spell (system.item): without this check each target's save card
    // of a weaponDamage spell got a weapon picker of the TARGET's weapons. Only the spell's own cards get the block: the
    // activity usage card ("usage") and the "display in chat" card ("item", in 5.3.3 a plain message).
    if (!["usage", "item"].includes(message.type)) return;

    const item = message.getAssociatedItem?.() ?? fromUuidSync(message.flags?.dnd5e?.item?.uuid ?? "", { strict: false });
    if (!hasWeaponDamage(item)) return;

    // dnd5e 5.3.3 card markup (templates/chat/activity-card.hbs, item-card.hbs): <div class="chat-card"> holds
    // <section class="card-header description collapsible"> (whose ".card-content" child is the collapsible, possibly
    // auto-collapsed description) followed by ".card-buttons". Insert the weapon block after the header so it stays
    // visible when the description is collapsed; fall back to appending to the card.
    const card = root.querySelector(".chat-card");
    if (!card || card.querySelector(WeaponDamageApplicationElement.tagName)) return;
    const element = document.createElement(WeaponDamageApplicationElement.tagName);
    const header = card.querySelector(".card-header");
    if (header) header.insertAdjacentElement("afterend", element);
    else card.appendChild(element);
  });

  // Inject light source configuration in spell sheet
  Hooks.on("renderItemSheet5e", async (sheet, html, data) => {
    if (sheet.item.type !== "spell") return;
    const root = html instanceof HTMLElement ? html : html[0];
    if (!root) return;

    const properties = sheet.item.system?.properties;
    const hasLight = properties?.has ? properties.has("lightSource") : properties?.includes?.("lightSource");
    if (!hasLight) return;

    // 5.3.3 details tab: <section class="details tab" data-tab="details"> (templates/items/details.hbs:1). The
    // earlier "tabs" part (item-sheet.mjs:59-62) renders <nav><a data-action="tab" data-tab="details"> first in DOM
    // order (Foundry templates/generic/tab-navigation.hbs:4), and querySelector with a selector list returns the first
    // match of ANY selector, so a bare [data-tab="details"] would pick the nav link; exclude nav descendants.
    const detailsTab = root.querySelector('section.tab.details, .tab.details, [data-tab="details"]:not(nav *)');
    if (!detailsTab || detailsTab.querySelector(".spell-light-source")) return;

    // Stored in this module's flags; the inputs are named flags.<module>.light.* so the item sheet's own
    // submitOnChange form handling persists them (system.light does not exist in the dnd5e spell schema).
    const flagsLight = sheet.item.flags?.[MODULE_ID]?.light ?? {
      dim: 40, bright: 20, color: "#ffeedd", animation: { type: "torch" }
    };

    const templateData = {
      hasLightSource: true,
      light: flagsLight,
      lightAnimationChoices: CONFIG.Canvas?.lightAnimations ?? {}
    };

    const render = foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
    const rendered = await render(`modules/${MODULE_ID}/templates/items/details-spell-light.hbs`, templateData);
    const div = document.createElement("div");
    div.className = "spell-light-source";
    div.innerHTML = rendered;
    detailsTab.appendChild(div);
  });

  // Handle light toggling when a spell effect is applied / disabled / re-enabled / removed.
  // Hook signatures (Foundry client/data/client-backend.mjs:164/337/466):
  // createX(doc, options, userId), updateX(doc, changed, options, userId), deleteX(doc, options, userId).
  Hooks.on("createActiveEffect", (effect, options, userId) => {
    if (effect.disabled) return;
    applySpellLight(effect, userId);
  });

  Hooks.on("updateActiveEffect", (effect, changed, options, userId) => {
    if (!foundry.utils.hasProperty(changed, "disabled")) return;
    if (changed.disabled) restoreSpellLight(effect, userId);
    else applySpellLight(effect, userId);
  });

  Hooks.on("deleteActiveEffect", (effect, options, userId) => {
    restoreSpellLight(effect, userId);
  });
}
