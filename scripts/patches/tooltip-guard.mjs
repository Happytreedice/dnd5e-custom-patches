import { log, warn } from "../utils/patch-helper.mjs";

/**
 * Защита от гонки в подсказках dnd5e.
 *
 * Tooltips5e#_onHoverContentLink асинхронный: он ждёт richTooltip(), и если за это время
 * курсор уходит с ссылки, Foundry успевает снять подсказку и game.tooltip.element
 * становится null. Дальше система записывает карточку в уже закрытую подсказку и читает
 * dataset у null:
 *
 *     this.tooltip.innerHTML = content;
 *     const { tooltipDirection } = game.tooltip.element.dataset;
 *
 * и в консоль летит «Cannot read properties of null (reading 'dataset')»
 * (dnd5e 6.0.6 module/tooltips.mjs:137-139).
 *
 * Патч оборачивает метод системы, а не копирует его, поэтому всё поведение 6.0.6 сохраняется
 * (второй аргумент { extras }, game.tooltip.deactivate() для битой ссылки, тема подсказки).
 * Системе передаётся тонкая обёртка документа: если пока грузилась карточка подсказка
 * закрылась или переключилась на другой элемент, richTooltip() возвращает пустой результат,
 * и система выходит до записи (tooltips.mjs:136). Ошибка, возникшая после закрытия подсказки
 * каким-то другим путём, гасится как запасной вариант.
 */
export function initTooltipGuard() {
  Hooks.once("ready", () => {
    const prototype = game.dnd5e?.tooltips?.constructor?.prototype;
    const original = prototype?._onHoverContentLink;
    if (typeof original !== "function") {
      warn("Tooltip guard: Tooltips5e#_onHoverContentLink не найден — патч пропущен.");
      return;
    }

    prototype._onHoverContentLink = async function (doc, options = {}) {
      const element = game.tooltip?.element;
      const guarded = doc && {
        richTooltip: async opts => {
          const result = await (doc.richTooltip?.(opts) ?? doc.system?.richTooltip?.(opts) ?? {});
          // Подсказка закрылась или переключилась, пока грузилась карточка: показывать уже нечего.
          return (element && game.tooltip?.element === element) ? result : {};
        }
      };
      try {
        return await original.call(this, guarded, options);
      } catch (err) {
        if (!game.tooltip?.element) return;
        throw err;
      }
    };

    log("Tooltip guard: подсказки больше не падают при быстром уводе курсора.");
  });
}
