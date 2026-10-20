import { MODULE_ID, log } from "../utils/patch-helper.mjs";

/**
 * Equipment Spellbook (§64-65).
 * All data lives in flags.dnd5e-custom-patches.spellbook = {enabled, spells: [uuid]}; system.spellbook does not exist
 * in the dnd5e 5.3.3 equipment schema, so the former system.spellbook.* updates were silent no-ops and were removed.
 */
export function initSpellbookEquipment() {
  log("Initializing Equipment Spellbook support...");

  const readSpellbook = item => item.flags?.[MODULE_ID]?.spellbook ?? {};

  // 1. Equipment sheet integration
  Hooks.on("renderItemSheet5e", async (sheet, html, data) => {
    if (sheet.item.type !== "equipment") return;
    const root = html instanceof HTMLElement ? html : html[0];
    if (!root) return;

    // 5.3.3 markup: templates/items/details.hbs:1 wraps the tab in <section class="details tab" data-tab="details">;
    // details-equipment.hbs:44-45 renders the properties with {{formField ... stacked=true classes="checkbox-grid
    // checkbox-grid-3"}}, i.e. Foundry's createFormGroup -> <div class="form-group stacked checkbox-grid checkbox-grid-3">
    // with a <div class="form-fields"> holding <label class="checkbox"><dnd5e-checkbox name="system.properties.X">...
    // (module/applications/fields.mjs:25-38 createMultiCheckboxInput).
    const detailsTab = root.querySelector('section.tab.details, .tab.details, [data-tab="details"]:not(nav *)');
    const propertiesGroup = (detailsTab ?? root).querySelector(
      '.form-group.checkbox-grid.checkbox-grid-3:has([name^="system.properties."]), .form-group.stacked.checkbox-grid'
    );
    const fieldsContainer = propertiesGroup?.querySelector(".form-fields") ?? propertiesGroup;

    const spellbookData = readSpellbook(sheet.item);
    const isEnabled = !!spellbookData.enabled;

    // Inject checkbox into equipment properties grid with tooltip hint
    if (!root.querySelector(".equipment-spellbook-checkbox")) {
      const checkboxLabel = document.createElement("label");
      checkboxLabel.className = "checkbox equipment-spellbook-checkbox";
      checkboxLabel.dataset.tooltip = "DND5E.EQUIPMENT.Spellbook.Hint";
      // Named after the flag path so the item sheet's own submitOnChange form handling (ItemSheet5e DEFAULT_OPTIONS
      // form.submitOnChange: true, item-sheet.mjs:42; dnd5e-checkbox is a form-associated element whose value is its
      // checked state, components/checkbox.mjs:152-157) persists it like the system.properties.* checkboxes.
      checkboxLabel.innerHTML = `
        <dnd5e-checkbox name="flags.${MODULE_ID}.spellbook.enabled" ${isEnabled ? "checked" : ""}${sheet.isEditable ? "" : " disabled"}></dnd5e-checkbox>
        <span>${game.i18n.localize("DND5E.EQUIPMENT.Spellbook.Title")}</span>
      `;

      const checkbox = checkboxLabel.querySelector('dnd5e-checkbox, input[type="checkbox"]');
      checkbox?.addEventListener("change", async ev => {
        // The sheet's form submit (bubbling "change" -> ApplicationV2#_onChangeForm -> submit) persists the flag and the
        // resulting document update re-renders the sheet, which re-runs this hook and shows/hides the spell list.
        // Only when the sheet does not submit on change do we persist here so the section still refreshes.
        if (sheet.options?.form?.submitOnChange) return;
        if (!sheet.isEditable) return;
        await sheet.item.setFlag(MODULE_ID, "spellbook.enabled", ev.target.checked);
      });

      if (fieldsContainer) {
        fieldsContainer.appendChild(checkboxLabel);
      } else if (detailsTab) {
        detailsTab.appendChild(checkboxLabel);
      }
    }

    if (!isEnabled || root.querySelector(".equipment-spellbook-container")) return;

    // Enrich spells data for rendering
    const spells = [];
    for (const uuid of (spellbookData.spells ?? [])) {
      const spell = await fromUuid(uuid);
      if (spell) {
        spells.push({
          uuid,
          name: spell.name,
          img: spell.img,
          link: `@UUID[${uuid}]{${spell.name}}`
        });
      }
    }

    const templateData = {
      source: { spellbook: spellbookData },
      spellbook: { spells },
      partId: sheet.id,
      // The template checks {{#if @root.editable}} around the remove buttons; DocumentSheetV2#isEditable
      editable: sheet.isEditable
    };

    const render = foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
    const rendered = await render(`modules/${MODULE_ID}/templates/items/details-equipment-spellbook.hbs`, templateData);
    const container = document.createElement("div");
    container.className = "equipment-spellbook-container";
    container.innerHTML = rendered;

    // Remove spell listener (setFlag updates the item, which re-renders the sheet)
    container.querySelectorAll('[data-action="spellbookRemoveSpell"]').forEach(btn => {
      btn.addEventListener("click", async ev => {
        ev.stopPropagation();
        const li = ev.target.closest("li[data-uuid]");
        const targetUuid = li?.dataset?.uuid;
        if (!targetUuid) return;

        const currentSpells = (readSpellbook(sheet.item).spells ?? []).filter(u => u !== targetUuid);
        await sheet.item.setFlag(MODULE_ID, "spellbook.spells", currentSpells);
      });
    });

    // Drop listener on spellbook section
    const spellbookFieldset = container.querySelector("fieldset.spellbook");
    if (spellbookFieldset && sheet.isEditable) {
      spellbookFieldset.addEventListener("dragover", ev => ev.preventDefault());
      spellbookFieldset.addEventListener("drop", async ev => {
        ev.preventDefault();
        ev.stopPropagation();

        let dropData;
        try {
          dropData = JSON.parse(ev.dataTransfer.getData("text/plain"));
        } catch {
          return;
        }

        if (dropData.type !== "Item") return;
        const droppedItem = await fromUuid(dropData.uuid);
        if (droppedItem?.type !== "spell") return;

        const currentSpells = new Set(readSpellbook(sheet.item).spells ?? []);
        if (currentSpells.has(droppedItem.uuid)) {
          ui.notifications.warn("DND5E.EQUIPMENT.Spellbook.Warning.Duplicate", { localize: true });
          return;
        }

        currentSpells.add(droppedItem.uuid);
        await sheet.item.setFlag(MODULE_ID, "spellbook.spells", Array.from(currentSpells));
      });
    }

    if (propertiesGroup) {
      propertiesGroup.insertAdjacentElement("afterend", container);
    } else if (detailsTab) {
      detailsTab.appendChild(container);
    }
  });

  // 2. Advancement Choice Flow injection for target spellbook.
  // NOTE: nothing consumes the selected value yet. AdvancementFlow (module/applications/advancement/advancement-flow.mjs)
  // is still an AppV1 FormApplication, so `html` is jQuery; the <select name="spellbook"> is added to the flow form but
  // no code reads it during ItemChoice advancement completion, so chosen spells are not recorded into the book.
  Hooks.on("renderAdvancementFlow", async (flow, html, context) => {
    if (flow.advancement?.type !== "ItemChoice") return;
    const actor = flow.item?.actor;
    if (!actor) return;

    // Find spellbooks in actor's inventory
    const spellbooks = actor.itemTypes.equipment.filter(eq => eq.flags?.[MODULE_ID]?.spellbook?.enabled);
    if (!spellbooks.length) return;

    const root = html instanceof HTMLElement ? html : html[0];
    if (!root || root.querySelector(".spellbook-target")) return;

    const options = { "": game.i18n.localize("DND5E.EQUIPMENT.Spellbook.Advancement.None") };
    for (const b of spellbooks) options[b.id] = b.name;

    const templateData = {
      partId: flow.id,
      spellbook: {
        options,
        value: ""
      }
    };

    const render = foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
    const rendered = await render(`modules/${MODULE_ID}/templates/advancement/spellbook-target.hbs`, templateData);
    const div = document.createElement("div");
    div.innerHTML = rendered;
    root.appendChild(div.firstElementChild);
  });
}
