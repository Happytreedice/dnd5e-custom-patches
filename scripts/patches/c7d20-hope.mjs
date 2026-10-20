import { MODULE_ID, log } from "../utils/patch-helper.mjs";

/**
 * Communal Hope (C7d20) & Ruleset support.
 */
export function initC7d20Hope() {
  log("Initializing Communal Hope (C7d20)...");

  // Register the communal Hope setting if not already present
  if (!game.settings.settings.has("dnd5e.hope")) {
    game.settings.register("dnd5e", "hope", {
      name: "SETTINGS.DND5E.HOPE.Name",
      hint: "SETTINGS.DND5E.HOPE.Hint",
      scope: "world",
      config: false,
      type: Number,
      default: 0,
      onChange: value => Hooks.callAll("dnd5e.hopeChanged", value)
    });
  }

  // Extend rules versions configuration
  if (CONFIG.DND5E) {
    CONFIG.DND5E.rulesVersions ??= {};
    CONFIG.DND5E.rulesVersions.c7d20 = "SETTINGS.DND5E.RULESVERSION.C7d20";
  }
  const rulesSetting = game.settings?.settings?.get("dnd5e.rulesVersion");
  if (rulesSetting?.choices) {
    rulesSetting.choices.c7d20 = "SETTINGS.DND5E.RULESVERSION.C7d20";
  }

  // Define game.dnd5e.hope API
  if (game.dnd5e) {
    Object.defineProperty(game.dnd5e, "hope", {
      configurable: true,
      enumerable: true,
      get() {
        return {
          get value() {
            return game.settings.get("dnd5e", "hope") ?? 0;
          },
          set(value) {
            value = Math.max(0, Math.round(Number(value) || 0));
            if (game.user.isGM) {
              game.settings.set("dnd5e", "hope", value);
            } else {
              // Players cannot write world settings: ask the active GM over this module's own socket channel
              // (module.json declares "socket": true). dnd5e 5.3.3 has no "system.dnd5e" socket handler and a module
              // must not emit on another package's channel, so the former system.dnd5e emit was removed.
              game.socket.emit(`module.${MODULE_ID}`, { action: "setHope", value });
            }
          }
        };
      }
    });

    game.dnd5e.setHope = function (value) {
      game.dnd5e.hope.set(value);
    };
  }

  // Socket listener for GM to apply player-requested Hope updates (module channel only, see above)
  const handleHopeSocket = data => {
    if (data?.action !== "setHope") return;
    if (game.users.activeGM !== game.user) return;
    const value = Math.max(0, Math.round(Number(data.value) || 0));
    game.settings.set("dnd5e", "hope", value);
  };

  game.socket.on(`module.${MODULE_ID}`, handleHopeSocket);

  // Re-render open sheets when Hope changes
  Hooks.on("dnd5e.hopeChanged", () => {
    foundry.applications.instances.forEach(app => {
      if (app.document?.type === "character" && typeof app.render === "function") {
        app.render(false);
      }
    });
  });

  // Inject Hope input into character sheet header if rulesVersion is c7d20.
  // dnd5e 5.3.3 has no class named ActorSheet5e, so "renderActorSheet5e" never fires. The character sheet class is
  // CharacterActorSheet (module/applications/actor/character-sheet.mjs:20) and ApplicationV2 dispatches
  // render{ClassName} for every class in the inheritance chain (Foundry client/applications/api/application.mjs
  // #callHooks), so "renderCharacterActorSheet" fires with (sheet, htmlElement, context, options).
  Hooks.on("renderCharacterActorSheet", (sheet, html, context) => {
    const actor = sheet.actor ?? sheet.document;
    if (actor?.type !== "character") return;
    const rulesVersion = dnd5e?.settings?.rulesVersion ?? game.settings.get("dnd5e", "rulesVersion");
    if (rulesVersion !== "c7d20") return;

    const root = html instanceof HTMLElement ? html : html[0];
    if (!root) return;

    // The whole header part is re-rendered on every render, but guard against a second injection anyway
    if (root.querySelector(".inspiration.hope")) return;

    // 5.3.3 header markup (templates/actors/character-header.hbs:26):
    // <button type="button" class="inspiration unbutton" data-action="toggleInspiration" ...>
    const inspEl = root.querySelector('button.inspiration[data-action="toggleInspiration"], .inspiration:not(.hope)');
    if (!inspEl) return;

    const currentHope = game.dnd5e?.hope?.value ?? game.settings.get("dnd5e", "hope") ?? 0;
    const hopeLabel = game.i18n.localize("DND5E.HopeLabel");
    const hopeTooltip = game.i18n.localize("DND5E.HopeTooltip");

    const hopeWrapper = document.createElement("label");
    hopeWrapper.className = "inspiration hope";
    hopeWrapper.setAttribute("aria-label", hopeLabel);
    hopeWrapper.setAttribute("data-tooltip", hopeTooltip);
    hopeWrapper.innerHTML = `
      <input type="number" data-name="dnd5e-hope" min="0" step="1" value="${currentHope}"
             style="font-size: 10px; color: #ffffff; width: 100%; height: 100%; padding: 0; border: none; background: transparent; text-align: center;">
    `;

    // No name attribute: a named input inside the sheet <form> would be included in every submitOnChange submit of
    // the actor sheet (FormDataExtended collects named fields only); Hope is a world setting, not actor data.
    const input = hopeWrapper.querySelector('input[data-name="dnd5e-hope"]');
    input.addEventListener("change", ev => {
      // Keep the value out of the sheet's own submitOnChange form handling: Hope is a world setting, not actor data
      ev.stopPropagation();
      game.dnd5e.setHope(ev.target.value);
    });

    inspEl.replaceWith(hopeWrapper);
  });
}
