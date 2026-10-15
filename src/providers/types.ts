/** Configuration for a single AI provider CLI */
export interface ProviderDef {
  /** Executable name or path */
  bin: string;
  /** Command-line arguments passed to the CLI */
  args: string[];
  /** Environment variables to set for this provider */
  env?: Record<string, string>;
  /** Environment variable names to remove (overrides inherited values) */
  clearEnv?: string[];
}
