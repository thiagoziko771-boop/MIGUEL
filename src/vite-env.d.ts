/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /**
   * ID do conjunto de dados do Meta (Pixel). É público — vai no HTML de
   * qualquer jeito. O token da API de Conversões é que nunca pode aparecer
   * aqui: `VITE_` significa "embutido no bundle e visível para todo mundo".
   */
  readonly VITE_META_PIXEL_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
