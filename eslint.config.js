import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['src/lib/**/*.test.js', 'vite.config.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    // public/tesseract/ and public/fonts/ are fetched vendor assets (see
    // scripts/fetch-ocr-assets.mjs / scripts/fetch-bravura-assets.mjs) --
    // gitignored, but only excluded from linting here once someone's actually
    // run predev/prebuild locally and populated them; add each fetched-asset
    // directory here as it's introduced, same as public/mediapipe/ already was.
    ignores: ['dist/', 'node_modules/', 'public/audio/', 'public/mediapipe/', 'public/tesseract/', 'public/fonts/'],
  },
];
