// The one Vite env flag studio-web reads. Declared here because pnpm does not expose vite's client types to tsc.
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
