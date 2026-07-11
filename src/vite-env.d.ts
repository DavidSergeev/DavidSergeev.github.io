/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LAMBDA_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
