import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['main.js', 'node_modules/**', 'coverage/**']),
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      ecmaVersion: 2021,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Product names and endpoint examples intentionally preserve their official casing.
      'obsidianmd/ui/sentence-case': 'off',
    },
  },
  {
    files: ['src/settings/settings-tab.ts'],
    rules: {
      // Imperative settings remain the compatibility fallback for minAppVersion 1.11.4.
      '@typescript-eslint/no-deprecated': 'off',
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'obsidianmd/prefer-window-timers': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      // Standalone Node.js tools do not run inside Obsidian's renderer process.
      'no-restricted-globals': 'off',
      'obsidianmd/hardcoded-config-path': 'off',
      'obsidianmd/no-global-this': 'off',
    },
  },
);
