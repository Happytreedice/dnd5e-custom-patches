import { MODULE_ID, log } from "./utils/patch-helper.mjs";
import { initC7d20Hope } from "./patches/c7d20-hope.mjs";
import { initMobAttacks } from "./patches/mob-attacks.mjs";
import { initWeaponDamageAndLight } from "./patches/weapon-damage-light.mjs";
import { initSlayerProperty } from "./patches/slayer-property.mjs";
import { initSpellbookEquipment } from "./patches/spellbook-equipment.mjs";
import { initEngineFixes } from "./patches/engine-fixes.mjs";
import { initEffectIcons } from "./patches/effect-icons.mjs";
import { initSpellChoiceLevel } from "./patches/spell-choice-level.mjs";
import { initSaveCritical } from "./patches/save-critical.mjs";
import { initTooltipGuard } from "./patches/tooltip-guard.mjs";
import { initChatLightTheme } from "./patches/chat-light-theme.mjs";

Hooks.once("init", () => {
  log("Initializing D&D 5e Custom Patches module...");

  initC7d20Hope();
  initMobAttacks();
  initWeaponDamageAndLight();
  initSlayerProperty();
  initSpellbookEquipment();
  initEngineFixes();
  initEffectIcons();
  initSpellChoiceLevel();
  initSaveCritical();
  initTooltipGuard();
  initChatLightTheme();
});

Hooks.once("ready", () => {
  log("D&D 5e Custom Patches module is ready.");
});
