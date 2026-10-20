import { log } from "../utils/patch-helper.mjs";

/**
 * Make the light chat log theme of dnd5e the default.
 *
 * dnd5e 6.x registers the client setting "dnd5e.chatLogTheme" with the initial value "" (inherit the interface theme,
 * which is dark by default). Only the default changes here: a theme the user picked explicitly in the system settings
 * is still respected. Called during init, after the system has registered its settings.
 */
export function initChatLightTheme() {
  const setting = game.settings.settings.get("dnd5e.chatLogTheme");
  if ( !setting ) return;
  setting.default = "light";
  if ( setting.type instanceof foundry.data.fields.DataField ) setting.type.initial = "light";
  log("Chat log theme defaults to light.");
}
