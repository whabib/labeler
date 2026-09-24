import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({ ignores: ["dist/", "node_modules/"] }, {
	files: ["**/*.ts"],
	extends: [tseslint.configs.strictTypeChecked],
	languageOptions: {
		parserOptions: { project: "./tsconfig.eslint.json", tsconfigRootDir: import.meta.dirname },
	},
	rules: {
		"@typescript-eslint/no-explicit-any": "off",
		"@typescript-eslint/no-misused-promises": "off",
		"@typescript-eslint/no-non-null-assertion": "off",
		// Replaces no-throw-literal (removed in typescript-eslint 8); the code throws
		// non-Error values for control flow (e.g. `throw 0` while parsing keys)
		"@typescript-eslint/only-throw-error": "off",
		"@typescript-eslint/no-unnecessary-condition": "off",
		"@typescript-eslint/no-unsafe-argument": "off",
		"@typescript-eslint/no-unsafe-assignment": "off",
		"@typescript-eslint/no-unsafe-call": "off",
		"@typescript-eslint/no-unsafe-member-access": "off",
		"@typescript-eslint/no-unsafe-return": "off",
		"@typescript-eslint/restrict-plus-operands": "off",
		"@typescript-eslint/restrict-template-expressions": "off",
		"@typescript-eslint/unified-signatures": "off",
	},
});
