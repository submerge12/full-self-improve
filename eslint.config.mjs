import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["node_modules/**", ".next/**", "dist/**", "coverage/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["next"],
          patterns: ["next/*", "src/app", "src/app/*", "@/app", "@/app/*", "../app", "../app/*"]
        }
      ]
    }
  }
];
