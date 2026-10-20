import { log, warn } from "../utils/patch-helper.mjs";

/**
 * Фильтр круга заклинаний при повышении уровня.
 *
 * Проблема: у классов-заклинателей выбор при повышении уровня разбит на два продвижения —
 * отдельно заговоры (ItemChoice с restriction.level = "0") и отдельно заклинания
 * (ItemChoice с restriction.level = "available"). Система dnd5e для значения "available"
 * задаёт браузеру компендиумов только верхнюю границу круга:
 *
 *     filters.locked.additional.level = { max: this._maxSpellSlotLevel() };
 *
 * Нижняя граница не задаётся, поэтому список открывается с 0 круга и игроки принимают
 * его за фильтр «только заговоры», хотя заговоры выбираются в соседнем продвижении.
 *
 * Решение: перед открытием браузера дописываем нижнюю границу min = 1, но ТОЛЬКО если
 * у того же класса/подкласса есть отдельное продвижение с выбором заговоров ИЗ ТОГО ЖЕ СПИСКА
 * заклинаний. Если такого соседа нет (например, «Магические секреты» барда, где заговоры
 * разрешены правилами и список не совпадает со списком заговоров барда), поведение системы
 * не меняется.
 *
 * dnd5e 6.0.6 добавил штатное значение restriction.level = "availableNoCantrips" (браузер, встроенный
 * список и перетаскивание без заговоров). Содержимое с ним патч не трогает; патч нужен для
 * классов, которые всё ещё используют "available" (копии классов laaru, fifthpendium, классы на
 * уже созданных персонажах). Правка чисто на стороне интерфейса, данные не меняются.
 */

/** Список заклинаний ограничения как отсортированный массив (Set в модели, массив в исходных данных). */
function restrictionList(configuration) {
  return Array.from(configuration?.restriction?.list ?? []).map(String).sort();
}

/**
 * Есть ли у того же предмета отдельный выбор заговоров.
 * @param {object} advancement  Продвижение, открывающее браузер.
 * @returns {boolean}
 */
function hasSeparateCantripChoice(advancement) {
  const configuration = advancement?.configuration;
  if (configuration?.type !== "spell") return false;
  if (configuration?.restriction?.level !== "available") return false;

  const list = restrictionList(configuration).join("|");
  const siblings = advancement?.item?.system?.advancement ?? [];
  return siblings.some(
    (entry) =>
      entry?.type === "ItemChoice" &&
      entry?.configuration?.type === "spell" &&
      String(entry?.configuration?.restriction?.level) === "0" &&
      entry?._id !== advancement.id &&
      restrictionList(entry.configuration).join("|") === list
  );
}

export function initSpellChoiceLevel() {
  Hooks.once("ready", () => {
    const ItemChoiceFlow = globalThis.dnd5e?.applications?.advancement?.ItemChoiceFlow;
    const CompendiumBrowser = globalThis.dnd5e?.applications?.CompendiumBrowser;
    const originalBrowse = ItemChoiceFlow?.DEFAULT_OPTIONS?.actions?.browse;

    if (typeof originalBrowse !== "function" || typeof CompendiumBrowser?.select !== "function") {
      warn(
        "Spell choice level: ItemChoiceFlow.DEFAULT_OPTIONS.actions.browse или CompendiumBrowser.select не найдены — патч пропущен."
      );
      return;
    }

    ItemChoiceFlow.DEFAULT_OPTIONS.actions.browse = async function (...args) {
      if (!hasSeparateCantripChoice(this.advancement)) {
        return originalBrowse.apply(this, args);
      }

      // Подменяем select только на время этого открытия браузера, чтобы не задеть
      // остальные места, где он вызывается.
      const originalSelect = CompendiumBrowser.select;
      CompendiumBrowser.select = function (options, ...rest) {
        const level = options?.filters?.locked?.additional?.level;
        if (level && level.max !== undefined && level.min === undefined) level.min = 1;
        return originalSelect.call(this, options, ...rest);
      };

      try {
        return await originalBrowse.apply(this, args);
      } finally {
        CompendiumBrowser.select = originalSelect;
      }
    };

    log("Spell choice level: выбор заклинаний при повышении уровня больше не начинается с заговоров.");
  });
}
