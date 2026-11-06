import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // evals/run-eval.mjs is the eval skill's runner scaffold, kept close to
    // upstream; its coach-specific hooks call the typed evals/coach-eval.ts.
    ignores: ["node_modules/**", ".vercel/**", "coverage/**", ".claude/**", "evals/run-eval.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": "error",
    },
  },
  {
    // The logger is the one place allowed to write to the console; the smoke
    // script prints the stream for a person to read.
    files: ["src/log.ts", "scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
