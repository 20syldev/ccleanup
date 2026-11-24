import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import checkFile from "eslint-plugin-check-file";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

export default defineConfig([
    globalIgnores(["dist", "node_modules"]),
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
        plugins: { "check-file": checkFile, import: importPlugin },
        rules: {
            "@typescript-eslint/ban-ts-comment": [
                "error",
                { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true },
            ],
            "check-file/filename-naming-convention": [
                "error",
                { "src/**/*.ts": "CAMEL_CASE" },
                { ignoreMiddleExtensions: true },
            ],
            "import/order": [
                "error",
                {
                    alphabetize: { order: "asc", caseInsensitive: true },
                    groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
                    "newlines-between": "always",
                },
            ],
            "sort-imports": ["error", { ignoreCase: true, ignoreDeclarationSort: true }],
        },
    },
    prettier,
]);
