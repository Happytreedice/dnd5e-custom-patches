import { MODULE_ID, log, warn, registerPatch } from "../utils/patch-helper.mjs";

/**
 * Engine fixes and system optimizations (§66, §78, §84, §98.1, secret sections, AC items, NPC HP roll).
 */
export function initEngineFixes() {
  log("Initializing Engine Fixes & Optimizations...");

  // 2. §78 / §78.1: ActiveEffect [[formula]] evaluation on creation with spellLevel & scaling support
  Hooks.on("preCreateActiveEffect", (effect, data, options, userId) => {
    if (game.user.id !== userId) return;

    // Helper to safely parse numbers without relying on non-existent Number.isNumeric
    const toNum = v => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      return null;
    };

    // Foundry v14 stores the changes at system.changes (common/data/active-effect.mjs:17; BaseActiveEffect.migrateData
    // moves a legacy root `changes` array there, common/documents/active-effect.mjs:171-173) and the root `changes` is
    // only a shim. Read the plain source data, never the DataModel instances, and remember which location it uses.
    const source = effect._source ?? {};
    const changesPath = Array.isArray(source.system?.changes) ? "system.changes" : "changes";
    const rawChanges = foundry.utils.deepClone(foundry.utils.getProperty(source, changesPath));
    if (!Array.isArray(rawChanges) || rawChanges.length === 0) return;

    // §78.1: The target actor's rollData lacks @item / @scaling. Extract spellLevel & scaling from flags (placed by dnd5e) or origin item.
    const spellLevelFlag = foundry.utils.getProperty(data, "flags.dnd5e.spellLevel")
      ?? foundry.utils.getProperty(effect._source, "flags.dnd5e.spellLevel")
      ?? effect.flags?.dnd5e?.spellLevel;
    let spellLevel = toNum(spellLevelFlag) ?? toNum(spellLevelFlag?.value);
    let scaling = toNum(foundry.utils.getProperty(data, "flags.dnd5e.scaling")
      ?? foundry.utils.getProperty(effect._source, "flags.dnd5e.scaling")
      ?? effect.flags?.dnd5e?.scaling) ?? 0;

    if (spellLevel === null && effect.origin) {
      try {
        const source = foundry.utils.parseUuid(effect.origin)?.type ? fromUuidSync(effect.origin) : null;
        const item = (source instanceof Item) ? source : (source?.parent instanceof Item ? source.parent : null);
        if (item?.system?.level !== undefined) {
          const itemScaling = toNum(item.getFlag?.("dnd5e", "scaling")) ?? 0;
          spellLevel = (toNum(item.system.level) ?? 2) + itemScaling;
          scaling = itemScaling;
        }
      } catch (_) {}
    }

    // Special handling for Aid ("Подмога") or hp.tempmax formulas: Aid is minimum 2nd level
    const hasAid = rawChanges.some(c =>
      c?.key === "system.attributes.hp.tempmax" && (
        (typeof c?.value === "string" && (c.value.includes("@item.level") || c.value.includes("[[")))
        || toNum(c?.value) === -5
      )
    );
    if (hasAid && (spellLevel === null || spellLevel < 2)) {
      spellLevel = 2;
    }

    const rollData = effect.parent?.getRollData?.() ?? {};
    if (spellLevel !== null) {
      rollData.item = { ...(rollData.item ?? {}), level: spellLevel };
      rollData.itemLevel = spellLevel;
      if (globalThis.dnd5e?.dataModels?.Scaling) {
        rollData.scaling = new dnd5e.dataModels.Scaling(scaling);
      } else {
        rollData.scaling = scaling;
      }
    }

    let rolledAny = false;
    const changes = rawChanges.map(change => {
      if (!change || typeof change !== "object") return change;

      // Ensure hp.tempmax from Aid is never negative
      if (change.key === "system.attributes.hp.tempmax") {
        const numVal = toNum(change.value);
        if (numVal !== null && numVal <= 0) {
          const validLvl = Math.max(spellLevel ?? 2, 2);
          rolledAny = true;
          return { ...change, value: (validLvl - 1) * 5 };
        }
        if (typeof change.value === "string" && (change.value.includes("@item.level") || change.value.includes("[["))) {
          const validLvl = Math.max(spellLevel ?? 2, 2);
          rolledAny = true;
          return { ...change, value: (validLvl - 1) * 5 };
        }
      }

      if (typeof change.value !== "string" || !change.value.includes("[[")) return change;
      const value = change.value.replace(/\[\[([^\]]+)\]\]/g, (match, formula) => {
        try {
          const roll = new Roll(formula, rollData);
          const total = roll.evaluateSync({ strict: false }).total;
          if (Number.isFinite(total)) {
            rolledAny = true;
            return String(total);
          }
          return match;
        } catch (err) {
          console.warn(`[${MODULE_ID}] Failed to evaluate inline roll "${formula}" for ActiveEffect:`, err);
          return match;
        }
      });
      return { ...change, value };
    });

    if (rolledAny) {
      // Write back only to the location the source uses (system.changes on v14, changes before) - never both.
      effect.updateSource({ [changesPath]: changes });
      if (data && typeof data === "object") foundry.utils.setProperty(data, changesPath, foundry.utils.deepClone(changes));
    }
  });

  // 3. §84: Container reference cleanup when copying item
  Hooks.on("preCreateItem", (item, data, options, userId) => {
    if (!item.parent || !(item.parent instanceof Actor)) return;
    const containerId = item.system?.container;
    if (containerId) {
      const containerExists = item.parent.items.has(containerId);
      if (!containerExists) {
        item.updateSource({ "system.container": null });
      }
    }
  });

  // 4. Secret sections in chat descriptions (GM-only)
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : html[0];
    if (!root) return;

    root.querySelectorAll("section.secret").forEach(sec => {
      sec.style.display = "none";
    });
  });

  // 5. Equipped magical non-armor AC bonus (Ring/Cloak of Protection)
  registerPatch("dnd5e.documents.Actor5e.prototype.prepareDerivedData", function (wrapped, ...args) {
    wrapped(...args);
    const ac = this.system?.attributes?.ac;
    if (!ac || !this.itemTypes?.equipment) return;

    let bonus = 0;
    const armorTypes = Object.keys(CONFIG.DND5E?.armorTypes ?? { light: 1, medium: 1, heavy: 1, natural: 1, shield: 1 });
    for (const equip of this.itemTypes.equipment) {
      if (!equip.system.equipped) continue;
      const type = equip.system.type?.value;
      // Skip actual armors and shields (dnd5e natively calculates their base AC and magicalBonus)
      if (armorTypes.includes(type)) continue;

      // Only magicalBonus on wondrous/rings/non-armor items is an AC bonus (e.g. Ring/Cloak of Protection); NEVER use armor.value
      const magicalBonus = Number(equip.system.armor?.magicalBonus) || 0;
      if (magicalBonus > 0) bonus += magicalBonus;
    }
    if (bonus > 0 && typeof ac.value === "number") {
      ac.value += bonus;
    }
  });

  // 6. Roll NPC HP on compendium import
  Hooks.on("createActor", async (actor, options, userId) => {
    if (game.user.id !== userId) return;
    if (actor.type !== "npc") return;

    // Skip bulk adventure imports
    if (options?.keepId && options?.render === false) return;

    // Only roll if created from a compendium source. Foundry v14 records it at _stats.compendiumSource
    // (common/data/fields.mjs:4045, filled by WorldCollection#fromCompendium, client/documents/abstract/world-collection.mjs:115);
    // flags.core.sourceId no longer exists and is only kept as a fallback for data written by older versions.
    const compendiumSource = actor._stats?.compendiumSource ?? actor._source?._stats?.compendiumSource
      ?? actor._source?.flags?.core?.sourceId ?? actor.flags?.core?.sourceId;
    if (!compendiumSource) return;

    const hpFormula = actor.system?.attributes?.hp?.formula;
    if (!hpFormula) return;

    try {
      const roll = new Roll(hpFormula);
      await roll.evaluate();
      await actor.update({
        "system.attributes.hp.max": roll.total,
        "system.attributes.hp.value": roll.total
      });

      roll.toMessage({
        flavor: game.i18n.format("DND5E.HPFormulaRollMessage", { name: actor.name }),
        speaker: ChatMessage.getSpeaker({ actor })
      });
    } catch (err) {
      console.warn(`[${MODULE_ID}] Failed to roll NPC HP formula "${hpFormula}":`, err);
    }
  });

  // 7c. Guard embedded Item / ActiveEffect deletes against ids that are not (or no longer) in the parent collection
  // Server log finding: bursts of 66-69 identical `Error: Item "<id>" does not exist!` (ServerDatabaseBackend._deleteDocuments)
  // right after one successful deletion of that id. The client pre-delete check (client/data/client-backend.mjs:403,
  // collection.get(id, {strict: true})) throws locally for an id that is already gone, so such a burst can only consist
  // of requests issued while the document still existed on the client; the server processes them one by one (semaphore
  // in the stack) and every request after the first fails.
  // Hypothesis for the source (consistent with the log, not reproduced): dnd5e 5.3.3 AdvancementManager#complete
  // (module/applications/advancement/advancement-manager.mjs:913-918) rewrites every item of the actor with
  // {diff: false, recursive: false}. ActivitiesTemplate#preUpdateActivities (activities.mjs:423-432) then sees `spell.uuid`
  // in the full data of every Cast activity, treats its cached spell as replaced and records the id in the operation
  // options shared by the whole batch (options.dnd5e.removedCachedItems). ActivitiesTemplate#onUpdateActivities
  // (activities.mjs:445-450) runs once per updated item and every run calls actor.deleteEmbeddedDocuments("Item", ...)
  // for that same id - one request per item with activities, matching the burst sizes (69 for one actor, 66 for
  // another) and the log order "create replacement item -> updates touching system.activities (riders warnings) ->
  // delete old item -> burst". The dependents cascades (ActiveEffect5e#_onDelete active-effect.mjs:667-673,
  // Item5e#_onDelete item.mjs:1156-1162) and onDeleteActivities target other documents and dedupe through the registry,
  // so they do not fit the pattern. dnd5e itself filters usage deletes with actor.items.has (activity/mixin.mjs:391).
  // Fix: drop duplicate ids, ids missing from the parent collection and ids whose deletion is still in flight for the
  // same parent (those duplicates wait for the pending request and resolve to []). Foundry v14 signature:
  // static deleteDocuments(ids=[], operation={}) (common/abstract/document.mjs:688); deleteAll requests pass no ids.
  //
  // dnd5e 6.x also deletes through foundry.documents.modifyBatch (Actor5e#performBulkUpdate for consumption, rests,
  // combat recovery and advancement; the concentration/dependents cascade in ActiveEffect5e._onDeleteOperation). Core's
  // ClientDatabaseBackend#modifyDocumentBatch calls deleteDocuments only as a dry run and then builds the request from
  // operation.ids, not from the return value (client/data/client-backend.mjs:529-533). So the guard writes the filtered
  // ids back to operation.ids (an op left without ids is skipped by core), and a wrapper on modifyDocumentBatch filters
  // the batch itself: ids already being deleted (direct calls or an earlier batch) and the same id in two ops of one
  // batch. Dry runs never register as in flight, otherwise a batch op would wait on its own batch.
  const pendingDeletes = new Map(); // parent uuid -> Map<id, Promise>
  const markInFlight = (key, ids, request) => {
    let inFlight = pendingDeletes.get(key);
    if (!inFlight) pendingDeletes.set(key, inFlight = new Map());
    for (const id of ids) inFlight.set(id, request);
    const release = () => {
      for (const id of ids) if (inFlight.get(id) === request) inFlight.delete(id);
      if (!inFlight.size && pendingDeletes.get(key) === inFlight) pendingDeletes.delete(key);
    };
    request.then(release, release);
  };
  const guardEmbeddedDeletes = (collectionName, isValidParent) => async function (wrapped, ids = [], operation = {}) {
    const parent = operation.parent;
    const collection = isValidParent(parent) ? parent[collectionName] : null;
    if (!collection || operation.deleteAll === true || !Array.isArray(ids)) return wrapped(ids, operation);
    const key = parent.uuid;
    const inFlight = operation.dryRun ? null : pendingDeletes.get(key);
    const waits = [];
    const toDelete = [];
    for (const id of new Set(ids)) {
      // Invalid documents are kept outside the main collection but may still be deleted by the GM.
      if (!collection.has(id) && !collection.invalidDocumentIds?.has(id)) continue;
      const pending = inFlight?.get(id);
      if (pending) waits.push(pending);
      else toDelete.push(id);
    }
    if (!toDelete.length) {
      if (waits.length) await Promise.allSettled(waits);
      operation.ids = []; // a batch builds its request from operation.ids: nothing left to send for this op
      return [];
    }
    if (operation.dryRun) return wrapped(toDelete, operation);
    const request = wrapped(toDelete, operation);
    markInFlight(key, toDelete, request);
    return request;
  };
  const isActor = doc => doc instanceof foundry.documents.Actor;
  const isActorOrItem = doc => isActor(doc) || doc instanceof foundry.documents.Item;
  registerPatch("dnd5e.documents.Item5e.deleteDocuments", guardEmbeddedDeletes("items", isActor), "MIXED");
  registerPatch("dnd5e.documents.ActiveEffect5e.deleteDocuments", guardEmbeddedDeletes("effects", isActorOrItem), "MIXED");

  // The batch side: CONFIG.DatabaseBackend is a foundry.data.ClientDatabaseBackend (client/config.mjs:133) and
  // foundry.documents.modifyBatch delegates to its modifyDocumentBatch (client/documents/_module.mjs:96-98).
  const BATCH_COLLECTIONS = { Item: ["items", isActor], ActiveEffect: ["effects", isActorOrItem] };
  registerPatch("foundry.data.ClientDatabaseBackend.prototype.modifyDocumentBatch", function (wrapped, operations, ...rest) {
    if (!Array.isArray(operations) || operations.some(o => o?.dryRun)) return wrapped(operations, ...rest);
    const claimed = new Map(); // parent uuid -> Set of ids taken by an earlier op of this batch
    const surviving = [];      // [parent uuid, ids]
    for (const op of operations) {
      const [collectionName, isValidParent] = BATCH_COLLECTIONS[op?.documentName] ?? [];
      if ((op?.action !== "delete") || !collectionName || (op.deleteAll === true) || !Array.isArray(op.ids)) continue;
      const parent = op.parent ?? ((typeof op.parentUuid === "string") ? fromUuidSync(op.parentUuid) : null);
      const collection = isValidParent(parent) ? parent[collectionName] : null;
      if (!collection) continue;
      const key = parent.uuid;
      const inFlight = pendingDeletes.get(key);
      const taken = claimed.get(key) ?? new Set();
      claimed.set(key, taken);
      op.ids = op.ids.filter(id => {
        if (taken.has(id) || inFlight?.has(id)) return false;
        if (!collection.has(id) && !collection.invalidDocumentIds?.has(id)) return false;
        taken.add(id);
        return true;
      });
      if (op.ids.length) surviving.push([key, op.ids.slice()]);
    }
    const batch = wrapped(operations, ...rest);
    for (const [key, ids] of surviving) markInFlight(key, ids, batch);
    return batch;
  }, "WRAPPER");

  // 8. Ability modifier fallback in rollData
  // During early initialization (e.g. prepareEmbeddedDocuments / applyActiveEffects("initial")),
  // derived ability modifiers (@abilities.<k>.mod) might not be calculated yet.
  // We ensure any rollData has fallback mod values calculated from ability scores to prevent warnings.
  registerPatch("dnd5e.documents.Actor5e.prototype.getRollData", function (wrapped, ...args) {
    const data = wrapped(...args);
    if (data?.abilities) {
      for (const [key, abl] of Object.entries(data.abilities)) {
        if (abl && typeof abl === "object") {
          if (abl.mod === undefined || abl.mod === null) {
            abl.mod = Math.floor(((abl.value ?? 10) - 10) / 2);
          }
        }
      }
    }
    return data;
  });

  // 9. Fix the PixiJS deprecation warning for PIXI.filters.BlurFilter (alias of PIXI.BlurFilter)
  if (globalThis.PIXI?.filters && globalThis.PIXI?.BlurFilter) {
    try {
      Object.defineProperty(PIXI.filters, "BlurFilter", {
        value: PIXI.BlurFilter,
        configurable: true,
        writable: true
      });
    } catch (_) {}
  }

  // 12. Safeguard ActiveEffect.applyChange: ensure hp.tempmax is never negative and handle undefined add targets
  const AE = globalThis.ActiveEffect;
  if (typeof AE?.applyChange === "function") {
    const origApplyChange = AE.applyChange;
    AE.applyChange = function (targetDoc, change, options) {
      if (change?.key === "system.attributes.hp.tempmax") {
        const val = Number(change.value);
        if (!isNaN(val) && val < 0) {
          change = foundry.utils.deepClone(change);
          change.value = Math.abs(val);
        }
      }
      // Safeguard: if change type is "add" but current property is undefined, convert to "override".
      // Foundry v14 identifies change types by the string `type` (common/data/active-effect.mjs:19); the numeric `mode`
      // is only a deprecated accessor added by BaseActiveEffect._shimChanges that logs a warning on every read or write.
      if (change?.type === "add") {
        const current = foundry.utils.getProperty(targetDoc, change.key);
        if (current === undefined) {
          change = foundry.utils.deepClone(change);
          change.type = "override";
        }
      }
      return origApplyChange.call(this, targetDoc, change, options);
    };
  }

  // 13. FormulaField: normalize unicode dashes and typographical minuses while cleaning ("1d6 − 1" -> "1d6 - 1"), so such
  // formulas are stored valid. Since 1.6.0 invalid formulas are no longer accepted silently (the old _validateType
  // override masked broken content such as "Noned0"); stock dnd5e behaviour applies: a world Item/Actor holding one is
  // unavailable (invalidDocumentIds, the sidebar only counts it), an embedded Item holding one is dropped from
  // actor.items (its data stays in the source), and a compendium entry loads with that field reset to its initial value.
  // Content is checked offline before release (FormulaField rule with the real dice engine).
  const FormulaField = dnd5e.dataModels?.fields?.FormulaField;
  if (FormulaField) {
    const origCleanType = FormulaField.prototype._cleanType;
    FormulaField.prototype._cleanType = function (value, options) {
      if (typeof value === "string") {
        value = value.replace(/[\u2212\u2013\u2014\ufe63\uff0d]/g, "-").trim();
      }
      return origCleanType ? origCleanType.call(this, value, options) : value;
    };
  }

  // 14. Optimize FontConfig._loadFonts: prioritize UI & canvas fonts, register other fonts for on-demand lazy loading without network queue saturation
  const FontConfig = foundry.applications?.settings?.menus?.FontConfig;
  if (FontConfig && typeof FontConfig._loadFonts === "function") {
    const availableEditorFonts = new Set();
    const origGetAvailableFonts = FontConfig.getAvailableFonts;
    FontConfig.getAvailableFonts = function () {
      const base = origGetAvailableFonts ? origGetAvailableFonts.call(this) : [];
      for (const f of availableEditorFonts) base.push(f);
      return Array.from(new Set(base)).sort();
    };

    FontConfig._loadFonts = async function ({ document, timeout = 2500 } = {}) {
      document ??= window.document;
      const allFonts = this._collectDefinitions();
      const essentialPromises = [];

      const essentialFamilies = new Set([
        "Signika",
        "Roboto",
        "Roboto Slab",
        CONFIG.defaultFontFamily,
        CONFIG.canvasTextStyle?.fontFamily
      ].filter(Boolean));

      for (const definitions of allFonts) {
        for (const [family, def] of Object.entries(definitions)) {
          if (def.editor) availableEditorFonts.add(family);
          if (essentialFamilies.has(family)) {
            essentialPromises.push(this.loadFont(family, def, { document }).catch(() => false));
          } else {
            // Register font face for on-demand lazy loading by browser when rendered,
            // avoiding upfront network saturation, connection pool starvation and render queue blocking.
            for (const font of def.fonts ?? []) {
              try {
                const fontFace = this._createFontFace(family, font);
                if (fontFace) document.fonts.add(fontFace);
              } catch (_) {}
            }
          }
        }
      }

      for (const font of document.fonts) {
        if (font.family.startsWith("Font Awesome") && font.status === "unloaded") {
          essentialPromises.push(font.load().catch(() => false));
        }
      }

      const wait = new Promise(resolve => setTimeout(resolve, Math.min(timeout, 600)));
      return Promise.race([Promise.all(essentialPromises), wait]).then(() => {
        log("Essential UI & Canvas fonts ready.");
      });
    };
  }

  // 14b. PixiJS v7+ deprecation: update filters.DisplacementFilter to modern DisplacementFilter
  const fixPixiFilters = () => {
    if (globalThis.PIXI?.filters && globalThis.PIXI.DisplacementFilter) {
      try {
        Object.defineProperty(globalThis.PIXI.filters, "DisplacementFilter", {
          value: globalThis.PIXI.DisplacementFilter,
          configurable: true,
          writable: true
        });
      } catch (_) {}
    }
  };
  fixPixiFilters();
  Hooks.once("init", fixPixiFilters);

  // 14c. Safety guard for PIXI.TextStyle: prevent crashes when fontFamily is undefined
  // PixiJS toFontString() crashes with TypeError: Cannot read properties of undefined (reading split)
  // if this._fontFamily is undefined or unset.
  const fixPixiTextStyle = () => {
    if (globalThis.PIXI?.TextStyle) {
      const proto = globalThis.PIXI.TextStyle.prototype;
      if (!proto._guardedToFontString) {
        const origToFontString = proto.toFontString;
        proto.toFontString = function () {
          if (!this._fontFamily) {
            this._fontFamily = CONFIG.canvasTextStyle?.fontFamily || CONFIG.defaultFontFamily || "Roboto";
          }
          return origToFontString.call(this);
        };
        proto._guardedToFontString = true;
      }
    }
    if (!CONFIG.canvasTextStyle?.fontFamily) {
      CONFIG.canvasTextStyle.fontFamily = CONFIG.defaultFontFamily || "Roboto";
    }
  };
  fixPixiTextStyle();
  Hooks.on("init", fixPixiTextStyle);
  Hooks.on("ready", fixPixiTextStyle);
  Hooks.on("canvasInit", fixPixiTextStyle);

  // 16. Ensure persistent Sequencer/Autoanimations end when ActiveEffect is disabled or deleted
  function endEffectAnimations(effect) {
    if (!globalThis.Sequencer?.EffectManager) return;
    try {
      const actor = effect.parent instanceof Item ? effect.parent.actor : effect.parent;
      const activeTokens = (actor && typeof actor.getActiveTokens === "function" ? actor.getActiveTokens() : []);
      const tokens = activeTokens.concat(actor?.token ? [actor.token] : []);

      const tokenIds = new Set();
      const tokenUuids = new Set();
      if (actor?.id) tokenIds.add(actor.id);
      if (actor?.uuid) tokenUuids.add(actor.uuid);
      for (const t of tokens) {
        if (t.id) tokenIds.add(t.id);
        if (t.document?.id) tokenIds.add(t.document.id);
        if (t.document?.uuid) tokenUuids.add(t.document.uuid);
        if (t.uuid) tokenUuids.add(t.uuid);
      }

      const candidateOrigins = new Set();
      if (effect.uuid) candidateOrigins.add(effect.uuid);
      if (effect.origin) {
        candidateOrigins.add(effect.origin);
        // If origin points to an Activity, also add parent Item uuid
        const actIdx = effect.origin.indexOf(".Activity.");
        if (actIdx !== -1) {
          candidateOrigins.add(effect.origin.slice(0, actIdx));
        }
        try {
          const originDoc = fromUuidSync(effect.origin);
          if (originDoc) {
            candidateOrigins.add(originDoc.uuid);
            if (originDoc.item?.uuid) candidateOrigins.add(originDoc.item.uuid);
            if (originDoc._stats?.compendiumSource) candidateOrigins.add(originDoc._stats.compendiumSource);
            if (originDoc.system?.activities) {
              const activities = originDoc.system.activities.values?.() ?? Object.values(originDoc.system.activities);
              for (const act of activities) {
                if (act.uuid) candidateOrigins.add(act.uuid);
                if (act.spell?.uuid) candidateOrigins.add(act.spell.uuid);
              }
            }
          }
        } catch (_) {}
      }

      const cachedFor = effect.flags?.dnd5e?.cachedFor;
      if (cachedFor) candidateOrigins.add(cachedFor);
      if (effect.parent instanceof Item) {
        candidateOrigins.add(effect.parent.uuid);
      }

      // Collect candidate names (both raw, bracket-cleaned, and alphanumeric-only rinsed)
      const candidateNames = new Set();
      const addNameVariations = (n) => {
        if (!n || typeof n !== "string") return;
        const lower = n.toLowerCase().trim();
        if (!lower) return;
        candidateNames.add(lower);

        // Extract inside brackets: e.g. "дубовая кожа [barkskin]" -> "barkskin"
        const bracketMatch = lower.match(/\[(.*?)\]/);
        if (bracketMatch && bracketMatch[1]?.trim()) {
          candidateNames.add(bracketMatch[1].trim());
        }

        // Clean out brackets: "дубовая кожа [barkskin]" -> "дубовая кожа"
        const noBrackets = lower.replace(/\[.*?\]/g, "").trim();
        if (noBrackets) candidateNames.add(noBrackets);

        // Alphanumeric only (matches AutoAnimations rinsedName)
        const rinsed = lower.replace(/[^a-zA-Z0-9\u0400-\u04FF]/g, "");
        if (rinsed) candidateNames.add(rinsed);

        // Common RU-EN pairings
        if (lower.includes("дубов") || lower.includes("barkskin")) {
          candidateNames.add("дубовая кожа");
          candidateNames.add("дубоваякожа");
          candidateNames.add("barkskin");
          candidateNames.add("дубоваякожаbarkskin");
        }
      };

      addNameVariations(effect.name);
      addNameVariations(effect.label);
      if (effect.origin) {
        try {
          const originDoc = fromUuidSync(effect.origin);
          if (originDoc) {
            addNameVariations(originDoc.name);
            if (originDoc.item?.name) addNameVariations(originDoc.item.name);
          }
        } catch (_) {}
      }

      // 1. End by candidate origins directly via Sequencer EffectManager.
      // Sequencer validates `object` against the canvas and throws "could not find object with ID" when the
      // placeable is already gone - which is the normal case here, since this runs while an effect (and often
      // its token) is being deleted. A throw would abort the whole cleanup, so each call is isolated.
      const endEffectsSafely = (filters) => {
        try {
          Sequencer.EffectManager.endEffects(filters);
        } catch (_) {
          // The object disappeared before its effects could be ended; nothing left to clean up for it.
        }
      };
      for (const origin of candidateOrigins) {
        endEffectsSafely({ origin });
        for (const token of tokens) {
          endEffectsSafely({ origin, object: token });
          if (token.id) endEffectsSafely({ origin, object: token.id });
        }
      }

      // 2. Also inspect all active Sequencer effects playing on canvas
      const allSeqEffects = Sequencer.EffectManager.effects ?? [];
      const effectsToEnd = [];

      for (const seqEff of allSeqEffects) {
        const effOrigin = seqEff.data?.origin;
        const effName = (seqEff.data?.name || "").toLowerCase().trim();
        const effRinsed = effName.replace(/[^a-zA-Z0-9\u0400-\u04FF]/g, "");

        const effSource = seqEff.data?.source;
        const effTarget = seqEff.data?.target;
        const effObj = seqEff.data?.object;

        const sourceId = (typeof effSource === "string" ? effSource : (effSource?.id ?? effSource?._id));
        const targetId = (typeof effTarget === "string" ? effTarget : (effTarget?.id ?? effTarget?._id));
        const objId = (typeof effObj === "string" ? effObj : (effObj?.id ?? effObj?._id));

        const sourceActorId = seqEff.source?.actor?.id ?? effSource?.actor?.id;
        const targetActorId = seqEff.target?.actor?.id ?? effTarget?.actor?.id;

        const matchesToken = tokenIds.size === 0 ||
          (sourceId && (tokenIds.has(sourceId) || tokenUuids.has(sourceId))) ||
          (targetId && (tokenIds.has(targetId) || tokenUuids.has(targetId))) ||
          (objId && (tokenIds.has(objId) || tokenUuids.has(objId))) ||
          (sourceActorId && tokenIds.has(sourceActorId)) ||
          (targetActorId && tokenIds.has(targetActorId)) ||
          tokens.some(t => seqEff.source === t || seqEff.target === t || seqEff.source === t.document);

        const matchesOrigin = effOrigin && candidateOrigins.has(effOrigin);

        let matchesName = false;
        if (effName) {
          for (const cn of candidateNames) {
            if (effName === cn || effRinsed === cn || (cn.length >= 4 && (effName.includes(cn) || cn.includes(effName)))) {
              matchesName = true;
              break;
            }
          }
        }

        if (matchesOrigin || (matchesToken && matchesName)) {
          effectsToEnd.push(seqEff);
        }
      }

      if (effectsToEnd.length > 0) {
        endEffectsSafely({ effects: effectsToEnd });
      }

      // 3. Clean up TokenMagic filters if present on token placeables
      if (globalThis.TokenMagic && activeTokens.length > 0) {
        for (const token of activeTokens) {
          for (const cn of candidateNames) {
            try {
              TokenMagic.deleteFilters(token, cn);
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      console.warn("engine-fixes | Error ending effect animations:", err);
    }
  }

  Hooks.on("updateActiveEffect", (effect, changes) => {
    if (changes.disabled === true) {
      endEffectAnimations(effect);
    }
  });

  Hooks.on("deleteActiveEffect", (effect) => {
    endEffectAnimations(effect);
  });

  // 17. Roll data of actors: every status of CONFIG.statusEffects is present (0 when the actor does not have it).
  // dnd5e 6.0.6 fills rollData.statuses only with the active statuses; the stock effect changes that reference an
  // absent one ("1 - @statuses.deafened" of Echolocation, dnd5e.monsters) fail in core's replaceFormulaData
  // ("Unable to replace all data references") and the change is skipped. With zeros the formula evaluates.
  const zeroFillStatuses = () => {
    const ActorClass = CONFIG.Actor?.documentClass;
    if (typeof ActorClass?.prototype?.getRollData !== "function" || ActorClass.prototype._statusesZeroFilled) return false;
    const origGetRollData = ActorClass.prototype.getRollData;
    ActorClass.prototype.getRollData = function (...args) {
      const rollData = origGetRollData.apply(this, args);
      if (rollData && typeof rollData === "object") {
        const statuses = (rollData.statuses && typeof rollData.statuses === "object") ? rollData.statuses : (rollData.statuses = {});
        for (const status of CONFIG.statusEffects ?? []) {
          if (status?.id && !(status.id in statuses)) statuses[status.id] = 0;
        }
      }
      return rollData;
    };
    ActorClass.prototype._statusesZeroFilled = true;
    log("Roll data statuses: every status present (0 when absent).");
    return true;
  };
  if (!zeroFillStatuses()) Hooks.once("setup", zeroFillStatuses);   // the system's actor class is set in its init hook
}
