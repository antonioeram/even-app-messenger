/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the home gateway, e.g. https://gateway.home.example */
  readonly VITE_GATEWAY_URL?: string
  /** Optional bearer token. It ends up inside the bundle: keep the build private. */
  readonly VITE_GATEWAY_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** package.json version, injected by vite.config.ts. */
declare const __APP_VERSION__: string
