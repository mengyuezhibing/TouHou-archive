/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' 表示构建为静态发布产物（无后端，数据来自预生成 JSON） */
  readonly VITE_TRS_STATIC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
