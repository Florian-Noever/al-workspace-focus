import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const nodeImports = [...new Set(builtinModules.flatMap(name => [name, `node:${name}`]))].map(name => ({
    name,
    message: 'Production runs in the browser worker. Use workspace.fs, vscode.Uri and Web APIs instead of Node builtins.'
}));

export default defineConfig(
    {
        ignores: ['node_modules/**', 'out/**', 'test/out/**', '.vscode-test/**', 'coverage/**', 'artifacts/**', '.focussed/**']
    },
    js.configs.recommended,
    {
        files: ['**/*.mjs', '**/*.cjs'],
        languageOptions: {
            globals: {
                Buffer: 'readonly',
                console: 'readonly',
                process: 'readonly',
                require: 'readonly',
                module: 'readonly',
                __dirname: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly'
            }
        }
    },
    {
        files: ['**/*.ts', '**/*.mts'],
        extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules: {
            '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'explicit' }],
            '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
            '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'curly': ['error', 'all'],
            'eqeqeq': ['error', 'always'],
            'no-console': 'error',
            'no-var': 'error',
            'prefer-const': 'error'
        }
    },
    {
        files: ['src/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: nodeImports,
                patterns: ['node:*']
            }],
            'no-restricted-globals': ['error', 'process', 'Buffer', 'require', 'global']
        }
    },
    {
        files: ['src/al/**/*.ts', 'src/workspace/**/*.ts', 'src/shared/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: [...nodeImports, {
                    name: 'vscode',
                    message: 'Domain modules must remain independent of VS Code. Put host effects in services or host modules.'
                }],
                patterns: ['node:*']
            }]
        }
    }
);
