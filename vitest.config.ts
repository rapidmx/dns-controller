import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.ts'],
        fileParallelism: false,
        pool: 'forks',
        execArgv: ['--no-experimental-strip-types'],
        clearMocks: true,
        coverage: {
            enabled: true,
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['**/node_modules/**', '**/test/**'],
            reporter: ['text', 'json', 'html', 'lcov'],
            thresholds: {
                'src/**': {
                    branches: 100,
                    functions: 100,
                    lines: 100,
                    statements: 100,
                },
            },
            reportsDirectory: 'coverage',
        },
        reporters: ['default', 'junit'],
        outputFile: {
            junit: 'junit.xml',
        },
    },
});
