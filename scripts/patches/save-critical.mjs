import { log, warn } from "../utils/patch-helper.mjs";

/**
 * Критические попадания для активности «Спасбросок».
 *
 * У активности «Урон» в схеме есть damage.critical { allow, bonus }, и окно настройки
 * показывает чекбокс «Разрешить критические попадания» и поле «Дополнительный урон при
 * критическом попадании». У активности «Спасбросок» этого нет совсем:
 *
 *   • в схеме damage только { onSave, parts };
 *   • SaveActivity#getDamageConfig(config, options) жёстко ставит rollConfig.critical.allow ??= false;
 *   • шаблон parts/save-damage.hbs не выводит соответствующих полей.
 *
 * Это мешает заклинаниям вроде «Громовой кары», где урон по спасброску привязан к атаке
 * оружием и должен удваиваться вместе с ней при критическом попадании.
 *
 * Патч добавляет недостающее на всех трёх уровнях, повторяя поведение активности «Урон».
 * Подписи полей берутся из готовых ключей DND5E.DAMAGE.FIELDS.damage.critical.*, поэтому
 * перевод подхватывается сам. Существующие активности ничего не теряют: пока чекбокс не
 * включён, поведение системы прежнее (критические попадания запрещены).
 */

const SAVE_DAMAGE_PARTIAL = "systems/dnd5e/templates/activity/parts/save-damage.hbs";

/** Шаблон окна: то же, что у системы, плюс блок критических попаданий. */
const SAVE_DAMAGE_TEMPLATE = `<fieldset>
    <legend>
        <span>{{ localize "DND5E.SAVE.FIELDS.damage.label" }}</span>
        <button type="button" class="unbutton control-button" data-action="addDamagePart"
                data-tooltip aria-label="{{ localize "DND5E.DAMAGE.Part.Action.Create" }}">
            <i class="fas fa-plus" inert></i>
        </button>
    </legend>
    {{ formField fields.damage.fields.onSave value=activity.damage.onSave options=onSaveOptions rootId=@root.partId }}
    {{#if fields.damage.fields.critical}}
    {{#with fields.damage.fields.critical.fields as |fields|}}
    {{ formField fields.allow value=../source.damage.critical.allow input=@root.inputs.createCheckboxInput
                 rootId=@root.partId }}
    {{#if ../source.damage.critical.allow}}
    {{ formField fields.bonus value=../source.damage.critical.bonus rootId=@root.partId }}
    {{/if}}
    {{/with}}
    {{/if}}
    {{> "systems/dnd5e/templates/activity/parts/damage-parts.hbs" }}
</fieldset>`;

/**
 * Достать класс активности «Спасбросок».
 * @returns {Function|null}
 */
function getSaveActivityClass() {
  return (
    CONFIG.DND5E?.activityTypes?.save?.documentClass ??
    globalThis.dnd5e?.documents?.activity?.SaveActivity ??
    null
  );
}

/**
 * Дописать critical { allow, bonus } в уже собранную схему.
 * @param {Function} SaveActivity  Класс активности.
 * @returns {boolean}  Удалось ли добавить поле.
 */
function injectCriticalField(SaveActivity) {
  const damage = SaveActivity?.schema?.fields?.damage;
  if (!damage?.fields) return false;
  if (damage.fields.critical) return true; // уже есть — повторный запуск безопасен

  const { SchemaField, BooleanField, StringField } = foundry.data.fields;
  const FormulaField = globalThis.dnd5e?.dataModels?.fields?.FormulaField ?? StringField;

  const critical = new SchemaField(
    {
      allow: new BooleanField({
        label: "DND5E.DAMAGE.FIELDS.damage.critical.allow.label",
        hint: "DND5E.DAMAGE.FIELDS.damage.critical.allow.hint"
      }),
      bonus: new FormulaField({
        label: "DND5E.DAMAGE.FIELDS.damage.critical.bonus.label",
        hint: "DND5E.DAMAGE.FIELDS.damage.critical.bonus.hint"
      })
    },
    { label: "DND5E.DAMAGE.FIELDS.damage.critical.allow.label" }
  );

  // Поля схемы связываются с родителем вручную, потому что SchemaField уже собран.
  critical.name = "critical";
  critical.parent = damage;
  for (const [name, field] of Object.entries(critical.fields)) {
    field.name = name;
    field.parent = critical;
  }
  damage.fields.critical = critical;
  return true;
}

export function initSaveCritical() {
  // Функция вызывается уже внутри хука init, поэтому схему и бросок правим сразу:
  // регистрировать ещё один Hooks.once("init") изнутри init ненадёжно.
  const SaveActivity = getSaveActivityClass();
  if (!SaveActivity) {
    warn("Save critical: класс активности «Спасбросок» не найден — патч пропущен.");
  } else if (!injectCriticalField(SaveActivity)) {
    // 1. Схема: добавляем damage.critical.
    warn("Save critical: не удалось дополнить схему damage — патч пропущен.");
  } else {
    // 2. Бросок: система принудительно запрещает крит, разрешаем его по настройке.
    const originalGetDamageConfig = SaveActivity.prototype.getDamageConfig;
    if (typeof originalGetDamageConfig !== "function") {
      warn("Save critical: getDamageConfig не найден — крит останется выключенным.");
    } else {
      // dnd5e 6.x: getDamageConfig(config, options) — options ({ formulaOptions, rollData }) передаются дальше,
      // иначе подписи урона (prepareDamageLabel) строятся с модификаторами костей и лишним getRollData().
      SaveActivity.prototype.getDamageConfig = function (config = {}, options = {}) {
        const rollConfig = originalGetDamageConfig.call(this, config, options);
        const critical = this.damage?.critical;
        if (critical?.allow) {
          rollConfig.critical ??= {};
          rollConfig.critical.allow = true;
          rollConfig.critical.bonusDamage ??= critical.bonus;
        }
        return rollConfig;
      };
      log("Save critical: активность «Спасбросок» получила настройку критических попаданий.");
    }
  }

  // 3. Окно настройки: подменяем шаблон блока урона на свой.
  Hooks.once("setup", () => {
    try {
      Handlebars.registerPartial(SAVE_DAMAGE_PARTIAL, Handlebars.compile(SAVE_DAMAGE_TEMPLATE));
      log("Save critical: шаблон save-damage.hbs дополнен полями критического попадания.");
    } catch (err) {
      warn("Save critical: не удалось подменить шаблон save-damage.hbs:", err);
    }
  });
}
