import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules', 'coverage', 'dist'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
  },
  {
    files: ['src/client/push.js', 'src/client/sw.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
  },
];
