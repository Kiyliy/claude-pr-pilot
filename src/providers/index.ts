import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";

export type { ProviderDef } from "./types";

/** Registry of all available AI providers. Add a new entry here to register a new provider. */
const PROVIDERS = {
  claude: claudeProvider,
  codex: codexProvider,
};

/** Union of all registered provider names, e.g. "claude" | "codex" */
export type AIProvider = keyof typeof PROVIDERS;

/** Return the CLI configuration for a given provider. */
export function getProviderDef(provider: AIProvider) {
  return PROVIDERS[provider];
}

/** Return all registered provider names. */
export function listProviders(): AIProvider[] {
  return Object.keys(PROVIDERS) as AIProvider[];
}

/** Type guard: check whether a string is a registered provider name. */
export function isValidProvider(value: string): value is AIProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}
