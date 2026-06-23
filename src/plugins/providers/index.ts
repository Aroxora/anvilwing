import { registerAnvilwingProviderPlugin } from './anvilwing/index.js';

let defaultsRegistered = false;

export function registerDefaultProviderPlugins(): void {
  if (defaultsRegistered) {
    return;
  }

  registerAnvilwingProviderPlugin();

  defaultsRegistered = true;
}
