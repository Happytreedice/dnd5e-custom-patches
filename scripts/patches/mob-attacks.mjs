import { MODULE_ID, log, warn } from "../utils/patch-helper.mjs";

/**
 * "Handling Mobs" table (DMG): the d20 result a creature needs to hit -> how many attackers are needed for one hit.
 */
export const mobAttackTable = [
  { max: 5, attackers: 1 },
  { max: 12, attackers: 2 },
  { max: 14, attackers: 3 },
  { max: 16, attackers: 4 },
  { max: 18, attackers: 5 },
  { max: 19, attackers: 10 },
  { max: 20, attackers: 20 }
];

/**
 * ChatMessage subtype declared in module.json (documentTypes.ChatMessage.mobAttack). Foundry namespaces module-declared
 * subtypes, so the real type string (validated by the server against the declared types) and the key looked up by
 * TypeDataField#getModelForType in CONFIG.ChatMessage.dataModels (common/data/fields.mjs:4280) is
 * "dnd5e-custom-patches.mobAttack".
 */
export const MOB_ATTACK_TYPE = `${MODULE_ID}.mobAttack`;

export function initMobAttacks() {
  log("Initializing Mob Attacks (Handling Mobs)...");

  // 1. Register mob attack table in CONFIG.DND5E
  CONFIG.DND5E ??= {};
  CONFIG.DND5E.mobAttackTable = mobAttackTable;

  // Helper number formatter
  const formatNumber = n => new Intl.NumberFormat(game.i18n.lang).format(n);

  // 2. Define MobAttackDialog
  // dnd5e 5.3.3 Dialog5e (module/applications/api/dialog.mjs): PARTS = content + footer, the window content tag is a
  // <form> whose submit event reaches options.form.handler (ApplicationV2#_onSubmitForm, application.mjs:2134), and the
  // footer renders this.options.buttons through templates/generic/form-footer.hbs (Dialog5e#_prepareFooterContext).
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
  // Dialog5e is exported only under the api namespace: module/applications/_module.mjs:4 -> api/_module.mjs:3.
  const Dialog5e = dnd5e.applications?.api?.Dialog5e;
  if (!Dialog5e) warn("dnd5e.applications.api.Dialog5e is missing; the mob attack dialog will render without its footer.");
  const DialogClass = Dialog5e ?? HandlebarsApplicationMixin(ApplicationV2);

  class MobAttackDialog extends DialogClass {
    #group;
    #config = null;

    constructor({ group, ...options } = {}) {
      super(options);
      this.#group = group;
    }

    static DEFAULT_OPTIONS = {
      classes: ["mob-attack"],
      window: {
        title: "DND5E.COMBAT.MobAttack.Title",
        icon: "fa-solid fa-users-rectangle"
      },
      form: {
        handler: MobAttackDialog.#handleFormSubmission
      },
      position: {
        width: 460
      },
      buttons: [{
        // form-footer.hbs renders type="{{button.type}}"; be explicit like dnd5e's own dialogs
        // (transform-dialog.mjs:25) instead of relying on the HTML default for an empty type.
        type: "submit",
        action: "resolve",
        label: "DND5E.COMBAT.MobAttack.Resolve",
        icon: "fa-solid fa-crosshairs",
        default: true
      }]
    };

    // Only the content part is replaced. The footer part inherited from Dialog5e (templates/generic/form-footer.hbs)
    // renders DEFAULT_OPTIONS.buttons, i.e. the Resolve submit button; overriding PARTS with content alone dropped it.
    static PARTS = {
      ...super.PARTS,
      content: {
        template: `modules/${MODULE_ID}/templates/apps/mob-attack-dialog.hbs`
      }
    };

    get config() {
      return this.#config;
    }

    get subtitle() {
      return this.#group?.name ?? "";
    }

    // Dialog5e#_preparePartContext routes the "content" part here (dialog.mjs:46-51).
    async _prepareContentContext(context, options) {
      context = (await super._prepareContentContext?.(context, options)) ?? context ?? {};
      const target = this.#group.mobAttackTarget;
      const NumberField = foundry.data.fields.NumberField;

      // The template renders these with the core {{formField}} helper (alias of formGroup,
      // client/applications/handlebars.mjs:128/531), which calls field.toFormGroup({label, hint, localize}, {name, value});
      // the fields therefore carry their own label/hint keys.
      context.target = target?.name ?? null;
      context.ac = {
        field: new NumberField({ nullable: false, integer: true, min: 1, label: "DND5E.ArmorClass" }),
        name: "ac",
        value: target?.actor?.system?.attributes?.ac?.value ?? 10
      };
      context.attackers = {
        field: new NumberField({
          nullable: false, integer: true, min: 1, label: "DND5E.COMBAT.MobAttack.Attackers"
        }),
        name: "attackers",
        value: this.#group.liveMembers?.length ?? 1
      };
      context.attackGroups = this.#group.mobAttackOptions ?? [];
      context.count = {
        field: new NumberField({
          nullable: false, integer: true, min: 1, label: "DND5E.COMBAT.MobAttack.AttackCount",
          hint: "DND5E.COMBAT.MobAttack.AttackCountHint"
        }),
        name: "count",
        value: 1
      };
      return context;
    }

    static #handleFormSubmission(event, form, formData) {
      const { ac, attackers, attack, count } = formData.object;
      this.#config = {
        ac: Math.max(1, Number(ac) || 1),
        attackers: Math.max(1, Number(attackers) || 1),
        attack,
        count: Math.max(1, Number(count) || 1)
      };
      // ApplicationV2#close(options) forwards options to _onClose (client/applications/api/application.mjs:1032).
      return this.close({ dnd5e: { submitted: true } });
    }

    _onClose(options = {}) {
      if (!options.dnd5e?.submitted) this.#config = null;
    }

    static prompt(group) {
      return new Promise(resolve => {
        const dialog = new this({ group });
        // ApplicationV2 dispatches the "close" event right after _onClose (application.mjs:1032).
        dialog.addEventListener("close", () => resolve(dialog.config), { once: true });
        dialog.render({ force: true });
      });
    }
  }

  // 3. Define MobAttackMessageData
  // dnd5e 5.3.3 ChatMessage5e#renderHTML (module/documents/chat-message.mjs:118-123) hands the whole card to
  // this.system.getHTML(html, options) when the system model defines it. ChatMessageDataModel
  // (module/data/abstract/chat-message-data-model.mjs) implements getHTML from metadata.template + _prepareContext and
  // dispatches [data-action] clicks to metadata.actions, so the model has to extend it for the card to render at all.
  const ChatMessageDataModel = dnd5e.dataModels?.abstract?.ChatMessageDataModel;
  if (!ChatMessageDataModel) warn("dnd5e.dataModels.abstract.ChatMessageDataModel is missing; mob attack cards will be empty.");
  const MessageModelBase = ChatMessageDataModel ?? foundry.abstract.TypeDataModel;
  const { NumberField, SchemaField, StringField } = foundry.data.fields;

  class MobAttackMessageData extends MessageModelBase {
    static defineSchema() {
      return {
        actor: new StringField(),
        target: new StringField(),
        ac: new NumberField({ integer: true }),
        attackers: new NumberField({ integer: true }),
        name: new StringField(),
        bonus: new NumberField({ integer: true }),
        required: new NumberField({ integer: true }),
        perHit: new NumberField({ integer: true, nullable: true }),
        strikers: new NumberField({ integer: true }),
        hits: new NumberField({ integer: true }),
        leftover: new NumberField({ integer: true }),
        attack: new SchemaField({
          activity: new StringField(),
          name: new StringField(),
          count: new NumberField({ integer: true }),
          hits: new NumberField({ integer: true })
        })
      };
    }

    // Merge into (not replace) the parent metadata so the inherited "use" action survives; same pattern as
    // AttackActivity.metadata (module/documents/activity/attack.mjs:29-41).
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata ?? {}, {
      actions: {
        rollDamage: MobAttackMessageData.#onRollDamage
      },
      template: `modules/${MODULE_ID}/templates/chat/mob-attack-summary.hbs`
    }, { inplace: false }));

    async _prepareContext(options) {
      const context = { buttons: [] };
      context.description = game.i18n.format(
        this.target ? "DND5E.COMBAT.MobAttack.Summary" : "DND5E.COMBAT.MobAttack.SummaryNoTarget", {
          name: this.name, attackers: formatNumber(this.attackers), target: this.target, ac: formatNumber(this.ac)
        }
      );

      const bonus = this.bonus < 0 ? formatNumber(this.bonus) : `+${formatNumber(this.bonus)}`;
      context.threshold = game.i18n.format(
        this.perHit ? "DND5E.COMBAT.MobAttack.Threshold" : "DND5E.COMBAT.MobAttack.ThresholdImpossible", {
          required: formatNumber(this.required), bonus, name: this.attack.name
        }
      );

      if (!this.perHit) {
        context.result = game.i18n.localize("DND5E.COMBAT.MobAttack.ResultImpossible");
      } else if (!this.hits) {
        context.result = game.i18n.format("DND5E.COMBAT.MobAttack.ResultNone", {
          per: formatNumber(this.perHit)
        });
      } else {
        const parts = [
          game.i18n.format(
            this.perHit === 1 ? "DND5E.COMBAT.MobAttack.RatioOne" : "DND5E.COMBAT.MobAttack.Ratio", {
              per: formatNumber(this.perHit)
            }
          ),
          game.i18n.format("DND5E.COMBAT.MobAttack.Hits", { hits: formatNumber(this.hits) })
        ];
        if (this.leftover) {
          parts.push(game.i18n.format("DND5E.COMBAT.MobAttack.Leftover", {
            leftover: formatNumber(this.leftover)
          }));
        }
        context.result = parts.join(" ");
        context.buttons.push({
          label: game.i18n.format("DND5E.COMBAT.MobAttack.DamageButton", {
            name: this.attack.name, hits: formatNumber(this.attack.hits)
          }),
          dataset: { action: "rollDamage" }
        });
      }
      return context;
    }

    // Invoked with `this` = the message data model (ChatMessageDataModel#onClick, chat-message-data-model.mjs:108-124).
    static async #onRollDamage(event, target) {
      const attack = this.attack;
      if (!attack?.hits) return;
      // Activity UUIDs resolve through Item5e#getEmbeddedDocument("Activity") (module/documents/item.mjs:1099), the same
      // way ChatMessageDataModel's own "use" action does (chat-message-data-model.mjs:148).
      const activity = await fromUuid(attack.activity);
      if (!activity) {
        ui.notifications.warn("DND5E.COMBAT.MobAttack.MissingActivity", { localize: true });
        return;
      }

      // Activity#getDamageConfig(config) returns { rolls: [{ data, parts, options }] } (module/data/activity/
      // base-activity.mjs:744-754) and Activity#rollDamage(config, dialog, message) (module/documents/activity/
      // mixin.mjs:869-935) rebuilds that config from the activity and appends config.rolls to it, so one copy of the
      // base rolls per additional hit yields one damage roll per hit in a single message.
      const base = activity.getDamageConfig();
      const rolls = [];
      for (let i = 1; i < attack.hits; i++) {
        rolls.push(...base.rolls.map(roll => foundry.utils.deepClone(roll)));
      }
      await activity.rollDamage({ event, rolls }, { configure: false }, {
        data: {
          flavor: game.i18n.format("DND5E.COMBAT.MobAttack.DamageFlavor", {
            name: attack.name, hits: formatNumber(attack.hits)
          })
        }
      });
    }
  }

  // Register the data model under the namespaced type. dnd5e assigns CONFIG.ChatMessage.dataModels wholesale in its own
  // init hook (dnd5e.mjs:141); that hook runs before this module's init because system scripts load before module scripts
  // (the CombatantGroup5e class below relies on the same ordering).
  // The former game.model / game.documentTypes / TYPES-getter patches were removed: the server validates ChatMessage#type
  // against the types declared in package manifests, so a client-only "mobAttack" entry never made such messages
  // creatable. module.json's documentTypes declaration is what registers the type.
  CONFIG.ChatMessage.dataModels ??= {};
  CONFIG.ChatMessage.dataModels[MOB_ATTACK_TYPE] = MobAttackMessageData;

  // 4. Extend CombatantGroup5e (dnd5e.mjs:81 sets CONFIG.CombatantGroup.documentClass in the system init hook)
  const CombatantGroup5e = CONFIG.CombatantGroup?.documentClass ?? dnd5e.documents?.CombatantGroup5e;
  if (CombatantGroup5e) {
    // dnd5e 5.3.3 CombatantGroup5e (module/documents/combatant-group.mjs) already defines activeCombatant, and Foundry's
    // CombatantGroup (client/documents/combatant-group.mjs) defines defeated, hidden, members and clearMovementHistories.
    // The module's former activeCombatant copy was dropped; only members the class lacks are added, as configurable
    // properties, so a later system version can take them over.
    const defineMissing = (target, descriptors, label) => {
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (name in target) {
          log(`${label}.${name} is already provided by the system; keeping the system implementation.`);
          continue;
        }
        Object.defineProperty(target, name, { configurable: true, enumerable: false, ...descriptor });
      }
    };
    const value = v => ({ value: v, writable: true });
    const getter = get => ({ get });

    defineMissing(CombatantGroup5e, {
      MobAttackDialog: value(MobAttackDialog),
      MobAttackMessageData: value(MobAttackMessageData),
      MOB_ATTACK_MESSAGE_CAP: value(30),

      mobAttackKey: value(function (activity) {
        return `${activity.item.id}-${activity.id}`;
      }),

      attackersPerHit: value(function (required) {
        if (required > 20) return null;
        return CONFIG.DND5E.mobAttackTable.find(row => required <= row.max)?.attackers ?? null;
      })
    }, "CombatantGroup5e");

    defineMissing(CombatantGroup5e.prototype, {
      isMob: getter(function () {
        return this.flags?.dnd5e?.mob === true;
      }),

      // Combatant#isDefeated: client/documents/combatant.mjs:125
      // The combatant that acts for the mob: the lowest-id living member, preferably one that is not hidden.
      // dnd5e's activeCombatant (lowest id, no state check, combatant-group.mjs:9-16) is kept for initiative only;
      // otherwise a defeated or hidden member could become the attack's actor and chat speaker.
      mobAttackCombatant: getter(function () {
        const live = this.liveMembers; // non-defeated, sorted by id
        return live.find(m => !m.hidden) ?? live[0] ?? this.activeCombatant;
      }),

      liveMembers: getter(function () {
        return Array.from(this.members).filter(m => !m.isDefeated).sort((a, b) => a.id.compare(b.id));
      }),

      mobAttackTarget: getter(function () {
        return game.user.targets.first()?.document ?? null;
      }),

      mobAttackActivities: getter(function () {
        const actor = this.mobAttackCombatant?.actor;
        if (!actor) return [];
        const activities = [];
        for (const item of actor.items) {
          for (const activity of item.system.activities?.getByType("attack") ?? []) {
            activities.push(activity);
          }
        }
        return activities;
      }),

      // activity.labels.toHit / labels.damages are prepared by AttackActivityData#prepareFinalData
      // (module/data/activity/attack-data.mjs:213-215) and BaseActivityData#prepareDamageLabel (base-activity.mjs:661).
      mobAttackOptions: getter(function () {
        const order = ["weapon", "spell", "feat"];
        const groups = new Map();
        for (const activity of this.mobAttackActivities) {
          const type = activity.item.type;
          if (!groups.has(type)) {
            groups.set(type, { type, label: game.i18n.localize(`TYPES.Item.${type}Pl`), options: [] });
          }
          const name = activity.item.name === activity.name
            ? activity.name : `${activity.item.name}: ${activity.name}`;
          const damage = (activity.labels.damages ?? []).map(d => d.label || d.formula).filterJoin(", ");
          groups.get(type).options.push({
            value: CombatantGroup5e.mobAttackKey(activity),
            label: game.i18n.format(
              damage ? "DND5E.COMBAT.MobAttack.OptionLabel" : "DND5E.COMBAT.MobAttack.OptionLabelNoDamage",
              { name, toHit: activity.labels.toHit, damage }
            )
          });
        }
        return Array.from(groups.values()).sort((a, b) => {
          const ai = order.indexOf(a.type);
          const bi = order.indexOf(b.type);
          return ((ai === -1) ? order.length : ai) - ((bi === -1) ? order.length : bi);
        });
      }),

      // Combat#rollInitiative(ids, options): client/documents/combat.mjs:384
      rollInitiative: value(async function (options = {}) {
        const combatant = this.activeCombatant;
        if (!combatant) return;
        return this.parent.rollInitiative([combatant.id], options);
      }),

      promptMobAttack: value(async function () {
        const combatant = this.mobAttackCombatant;
        if (!combatant?.actor) {
          ui.notifications.warn("DND5E.COMBAT.MobAttack.MissingActor", { localize: true });
          return;
        }
        if (!this.mobAttackActivities.length) {
          ui.notifications.warn("DND5E.COMBAT.MobAttack.NoAttacks", { localize: true });
          return;
        }

        const config = await MobAttackDialog.prompt(this);
        if (!config) return;
        const activity = this.mobAttackActivities.find(a => CombatantGroup5e.mobAttackKey(a) === config.attack);
        if (!activity) {
          ui.notifications.warn("DND5E.COMBAT.MobAttack.MissingActivity", { localize: true });
          return;
        }

        // labels.modifier is the deterministic attack bonus as a string, e.g. "+5" (attack-data.mjs:213).
        const bonus = parseInt(activity.labels.modifier) || 0;
        const required = Math.clamp(config.ac - bonus, 1, 21);
        const perHit = CombatantGroup5e.attackersPerHit(required);
        const strikers = perHit ? Math.floor(config.attackers / perHit) : 0;
        const hits = strikers * config.count;
        const name = activity.item.name === activity.name ? activity.name : `${activity.item.name}: ${activity.name}`;

        const message = await ChatMessage.implementation.create({
          speaker: ChatMessage.implementation.getSpeaker({ actor: combatant.actor, token: combatant.token }),
          system: {
            actor: combatant.actor.uuid,
            target: this.mobAttackTarget?.name ?? "",
            ac: config.ac,
            attackers: config.attackers,
            name: this.name,
            bonus, required, strikers, hits,
            perHit: perHit ?? null,
            leftover: perHit ? config.attackers - (strikers * perHit) : config.attackers,
            attack: { activity: activity.uuid, name, count: config.count, hits }
          },
          type: MOB_ATTACK_TYPE,
          whisper: ChatMessage.implementation.getWhisperRecipients("GM").map(u => u.id)
        });

        const posted = Math.min(hits, CombatantGroup5e.MOB_ATTACK_MESSAGE_CAP);
        if (hits > posted) {
          ui.notifications.info(game.i18n.format("DND5E.COMBAT.MobAttack.MessageCap", {
            posted: formatNumber(posted), hits: formatNumber(hits)
          }));
        }
        // AttackActivity#rollAttack(config, dialog, message) (module/documents/activity/attack.mjs:85-130) merges
        // config.rolls[0] into its own roll via D20Roll.mergeConfigs; D20Roll.mergeOptions keeps minimum/maximum
        // (module/dice/d20-roll.mjs:262-268), D20Roll.fromConfig keeps options.target (d20-roll.mjs:56) and
        // configureModifiers applies the range to the d20 (d20-roll.mjs:223-236), so every posted roll shows exactly the
        // required d20 result against the entered AC. dialog.configure = false skips the roll dialog
        // (module/dice/basic-roll.mjs:110) and message.data.flavor overrides the default flavor (attack.mjs:153-166).
        for (let hit = 1; hit <= posted; hit++) {
          await activity.rollAttack({
            rolls: [{ options: { minimum: required, maximum: required, target: config.ac } }]
          }, { configure: false }, {
            data: {
              flavor: game.i18n.format("DND5E.COMBAT.MobAttack.HitFlavor", {
                name, current: formatNumber(hit), total: formatNumber(posted)
              })
            }
          });
        }

        return message;
      })
    }, "CombatantGroup5e.prototype");
  }

  // 5. Combat Tracker Sidebar integration

  /**
   * Stand-in for a dnd5e group that has no CombatantGroup document (identical combatants sharing an initiative).
   * The mob members added above (mobAttackCombatant, liveMembers, mobAttackTarget, mobAttackActivities, mobAttackOptions,
   * rollInitiative, promptMobAttack) and dnd5e's activeCombatant (combatant-group.mjs:9-16) read only members, name, flags and parent,
   * so an object on the CombatantGroup5e prototype with those four own properties runs the same flow without creating a
   * document (a real group would change the group id dnd5e 6.0.6 shares initiative by, combatant.mjs:78).
   * The members are the combatant rows dnd5e rendered into this group, i.e. what this user sees: hidden combatants
   * only for their owners and the GM, defeated ones included (mobAttackCombatant / liveMembers skip those).
   * @param {CombatTracker} app
   * @param {Combat} combat
   * @param {HTMLElement} groupEl  The li.combatant-group element.
   * @returns {object|null}
   */
  const initiativeGroupView = (app, combat, groupEl) => {
    if (!CombatantGroup5e) return null;
    const combatants = Array.from(groupEl.querySelectorAll(".group-children [data-combatant-id]"))
      .map(el => combat.combatants.get(el.dataset.combatantId))
      .filter(Boolean);
    if (combatants.length < 2) return null;
    const name = app.constructor.getGroupName?.(combatants) || combatants[0].name;
    return Object.create(CombatantGroup5e.prototype, {
      parent: { value: combat },
      members: { value: new Set(combatants) },
      name: { value: name },
      flags: { value: {} }
    });
  };

  Hooks.on("renderCombatTracker", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    // dnd5e CombatTracker5e#renderGroups (6.0.6 module/applications/combat/combat-tracker.mjs:54-110) is attached by the
    // system at script load (dnd5e.mjs:757), so it has already run when this init-registered hook fires. It builds
    // li.combatant-group elements whose dataset.groupKey is Combatant5e#getGroupingKey(): the CombatantGroup id when the
    // combatants belong to a CombatantGroup document, otherwise "<initiative>:<disposition>:<baseActorId>" with no
    // document behind it (combatant.mjs:65-69, token.mjs:219-222). Nothing creates CombatantGroup documents any more
    // (the old local dnd5e patch §82 did), and dnd5e 6.0.6 rolls one shared initiative for identical unlinked tokens
    // (setting initiativeGroupRoll, combat.mjs:64-85), so identical enemies now always form such a document-less group.
    // Those get a stand-in on the CombatantGroup5e prototype, so the mob attack works for both kinds of group.
    const combat = app.viewed ?? game.combats?.active;
    if (!combat) return;

    for (const groupEl of root.querySelectorAll(".combatant-group")) {
      const key = groupEl.dataset.groupKey;
      const group = key ? (combat.groups?.get(key) ?? initiativeGroupView(app, combat, groupEl)) : null;
      if (!group) continue;
      // The mob attack rolls with the nominated combatant's actor, so offer it to GMs and that actor's owners only.
      if (!game.user.isGM && !group.mobAttackCombatant?.actor?.isOwner) continue;

      const header = groupEl.querySelector(".group-header");
      if (!header || header.querySelector('[data-action="mobAttack"]')) continue;

      // Same markup as the core combatant controls (templates/sidebar/tabs/combat/tracker.hbs:12-16): icon classes on
      // the button itself.
      const title = game.i18n.localize("DND5E.COMBAT.MobAttack.Title");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "inline-control combatant-control icon fa-solid fa-users-rectangle";
      btn.dataset.action = "mobAttack";
      btn.dataset.tooltip = title;
      btn.setAttribute("aria-label", title);
      btn.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopPropagation(); // the group header click toggles the collapsible (combat-tracker.mjs:96-101)
        group.promptMobAttack?.();
      });

      // dnd5e's group header (combat-tracker.mjs:78-90) has no controls container; add one inside .token-name like the
      // core combatant row (tracker.hbs:10-12) so the module's .combatant-controls styles apply.
      let controls = header.querySelector(".combatant-controls");
      if (!controls) {
        controls = document.createElement("div");
        controls.className = "combatant-controls";
        (header.querySelector(".token-name") ?? header).append(controls);
      }
      controls.prepend(btn);
    }
  });

  // 6. Highlight mob members on turn change
  // Hooks.callAll("combatTurnChange", combat, previous, current) (client/documents/combat.mjs:888) with
  // current.combatantId (combat.mjs:827); Token RENDER_FLAGS.refreshBorder (client/canvas/placeables/token.mjs:86).
  Hooks.on("combatTurnChange", (combat, prev, curr) => {
    const combatant = combat.combatants.get(curr?.combatantId);
    if (!combatant?.group) return;
    for (const member of combatant.group.members) {
      const token = member.token?.object;
      if (token && !token.destroyed) {
        token.renderFlags.set({ refreshBorder: true });
      }
    }
  });

  // 7. Mob group synchronization
  // The original port called Combat5e#_synchronizeMobGroups on createCombat and applyTokenStatusEffect. Stock dnd5e
  // (5.3.3 and 6.0.6) has no such method and creates no CombatantGroup documents; its tracker groups identical combatants
  // by a shared initiative key instead, which section 5 handles with a stand-in group. liveMembers already filters
  // defeated combatants, so no synchronization is needed.
}
