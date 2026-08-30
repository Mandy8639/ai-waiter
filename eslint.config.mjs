import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // Server actions used with useActionState must accept
      // (prevState, formData) whether or not they read them, so a
      // deliberately unused argument is a normal part of that signature
      // rather than an oversight. The codebase already marks those with a
      // leading underscore; this makes that convention actually mean
      // something instead of passing only when the unused argument happens
      // not to be last (no-unused-vars defaults to "after-used").
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
