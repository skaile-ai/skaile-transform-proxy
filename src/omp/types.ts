// The slice of the omp extension API this extension uses. Declared structurally: omp loads the
// extension with its own runtime, so the package never imports omp at runtime or for types.

export interface OmpModel {
  readonly provider: string
  readonly id: string
  readonly api: string
  readonly baseUrl?: string
}

/** A runtime provider override: omp merges `headers` into the provider's existing headers. */
export interface OmpProviderOverride {
  baseUrl?: string
  headers?: Record<string, string>
}

export interface OmpModelRegistry {
  getAll(): readonly OmpModel[]
  find(provider: string, modelId: string): OmpModel | undefined
  getProviderBaseUrl(provider: string): string | undefined
  getProviderHeaders(provider: string): Record<string, string> | undefined
  registerProvider(name: string, config: OmpProviderOverride, sourceId?: string): void
  /**
   * Clears the runtime overrides of every provider registered under `sourceId` and reloads the
   * static (built-in / models.yml) config once. `unregisterProvider` reloads once per provider:
   * about half a second each, with ~80 built-in providers.
   */
  clearSourceRegistrations(sourceId: string): void
}

export type OmpNotifyType = 'info' | 'warning' | 'error'

export interface OmpUi {
  notify(message: string, type?: OmpNotifyType): void
  setStatus(key: string, text: string | undefined): void
}

export interface OmpContext {
  readonly ui: OmpUi
  readonly cwd: string
  readonly modelRegistry: OmpModelRegistry
  readonly sessionManager: { getSessionId(): string }
  /** The session's active model: a snapshot that a provider override does not update. */
  readonly model: OmpModel | undefined
}

export interface OmpAutocompleteItem {
  value: string
  label: string
  description?: string
}

export type OmpEventName = 'session_start' | 'before_agent_start' | 'turn_start'

/** Per-session actions of the extension API. */
export interface OmpSessionActions {
  /** Rebinds the session's active model (without persisting it as the default). */
  setModel(model: OmpModel): Promise<boolean>
}

export interface OmpExtensionApi extends OmpSessionActions {
  registerCommand(
    name: string,
    options: {
      description?: string
      getArgumentCompletions?: (argumentPrefix: string) => OmpAutocompleteItem[] | null
      handler: (args: string, ctx: OmpContext) => Promise<void>
    },
  ): void
  on(event: OmpEventName, handler: (event: unknown, ctx: OmpContext) => void | Promise<void>): void
}
