import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'data',
                    include: ['test/data/**/*.test.ts'],
                    environment: 'node',
                    restoreMocks: true,
                    clearMocks: true,
                    testTimeout: 15000
                }
            },
            {
                resolve: {
                    alias: {
                        vscode: fileURLToPath(new URL('./test/support/vscodeMock.ts', import.meta.url))
                    }
                },
                test: {
                    name: 'host',
                    include: ['test/host/**/*.test.ts'],
                    environment: 'node',
                    restoreMocks: true,
                    clearMocks: true,
                    testTimeout: 15000
                }
            },
            {
                test: {
                    name: 'repo',
                    include: ['test/repo/**/*.test.ts'],
                    environment: 'node',
                    restoreMocks: true,
                    clearMocks: true,
                    testTimeout: 15000
                }
            }
        ]
    }
});
