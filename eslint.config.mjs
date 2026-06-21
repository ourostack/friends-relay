import tseslint from "typescript-eslint"

export default [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/__tests__/**"],
    languageOptions: {
      parser: tseslint.parser,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // The relay NEVER writes to console: it logs metadata ONLY, through an
      // injected structured logger, so it can never accidentally log a payload it
      // can't even read. `no-console` makes that structural.
      "no-console": "error",
    },
  },
  {
    // The storage layer (src/store/) is a pure interface + reference backends. It
    // must NEVER import the HTTP server surface (src/server/, src/http) — the
    // dependency direction is store ← server, never store → server. This keeps the
    // backend swappable without dragging in the transport.
    files: ["src/store/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/server", "**/server/**", "**/http", "**/http/**", "**/bin"],
          message: "src/store/ must not import the HTTP server surface (the storage backend stays transport-free)",
        }],
      }],
    },
  },
]
