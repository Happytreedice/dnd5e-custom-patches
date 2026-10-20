/**
 * Helper utility for wrapping methods safely with or without libWrapper.
 */
export const MODULE_ID = "dnd5e-custom-patches";

export function log(...args) {
  console.log(`[${MODULE_ID}]`, ...args);
}

export function warn(...args) {
  console.warn(`[${MODULE_ID}]`, ...args);
}

export function error(...args) {
  console.error(`[${MODULE_ID}]`, ...args);
}

let isLibWrapperReady = false;
const pendingRegistrations = [];

function registerWithLibWrapper(target, fn, type) {
  try {
    globalThis.libWrapper.register(MODULE_ID, target, fn, type);
  } catch (err) {
    warn(`libWrapper registration failed for ${target}:`, err);
  }
}

function applyFallback(target, fn) {
  try {
    const parts = target.split(".");
    const fnName = parts.pop();
    let obj = globalThis;
    for (const part of parts) {
      obj = obj?.[part];
      if (!obj) break;
    }

    if (!obj || typeof obj[fnName] !== "function") {
      warn(`Could not resolve target function ${target} for fallback wrapping.`);
      return;
    }

    const original = obj[fnName];
    obj[fnName] = function (...args) {
      return fn.call(this, original.bind(this), ...args);
    };
  } catch (err) {
    error(`Fallback patch failed for ${target}:`, err);
  }
}

Hooks.once("libWrapper.Ready", () => {
  isLibWrapperReady = true;
  while (pendingRegistrations.length) {
    const { target, fn, type } = pendingRegistrations.shift();
    registerWithLibWrapper(target, fn, type);
  }
});

/**
 * Register a method patch.
 * @param {string} target  Path to the target method, e.g. "dnd5e.documents.Actor5e.prototype.prepareDerivedData"
 * @param {Function} fn    Wrapper function: function(wrapped, ...args)
 * @param {string} [type="WRAPPER"]  "WRAPPER", "MIXED", or "OVERRIDE"
 */
export function registerPatch(target, fn, type = "WRAPPER") {
  if (globalThis.libWrapper && !globalThis.libWrapper.is_fallback) {
    if (isLibWrapperReady) {
      registerWithLibWrapper(target, fn, type);
    } else {
      pendingRegistrations.push({ target, fn, type });
    }
    return;
  }

  // Fallback: manual monkey-patching
  applyFallback(target, fn);
}
