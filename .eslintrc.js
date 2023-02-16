module.exports = {
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module",
  },
  plugins: ["@typescript-eslint/eslint-plugin", "prettier"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
  ],
  root: true,
  env: {
    node: true,
  },
  ignorePatterns: ["dist", "tslint.json", "node_modules"],
  rules: {
    "@typescript-eslint/interface-name-prefix": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "sort-imports": [
      "error",
      {
        ignoreCase: true,
        allowSeparatedGroups: true,
      },
    ],
    curly: [2, "multi-line"],
    "max-len": [
      "error",
      {
        code: 120,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
      },
    ],
    "comma-dangle": ["error", "always-multiline"],
  },
};
