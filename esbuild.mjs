import { mkdir, rm } from 'node:fs/promises';

import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'out/extension.js',
    bundle: true,
    platform: 'browser',
    // The JSONC parser's UMD factory hides its relative requires from the bundler.
    mainFields: ['browser', 'module', 'main'],
    format: 'cjs',
    target: 'es2022',
    external: ['vscode'],
    sourcemap: watch,
    sourcesContent: false,
    minify: !watch,
    legalComments: 'eof',
    logLevel: 'warning'
};

await mkdir('out', { recursive: true });
if (watch) {
    const watcher = await context({
        ...options,
        logLevel: 'silent',
        plugins: [{
            name: 'esbuild-problem-matcher',
            setup(builder) {
                builder.onStart(() => {
                    console.log('[watch] build started');
                });
                builder.onEnd(result => {
                    for (const [severity, symbol, messages] of [['ERROR', '\u2718', result.errors], ['WARNING', '\u25B2', result.warnings]]) {
                        for (const { text, location } of messages) {
                            console.error(`${symbol} [${severity}] ${text}`);
                            if (location) {
                                console.error(`    ${location.file}:${location.line}:${location.column}:`);
                            }
                        }
                    }
                    console.log('[watch] build finished');
                });
            }
        }]
    });
    await watcher.watch();
    let stopping = false;
    const stop = () => {
        if (!stopping) {
            stopping = true;
            watcher.dispose().catch(error => {
                console.error(error);
                process.exitCode = 1;
            });
        }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
} else {
    const { generateLicenseFile } = await import('generate-license-file');
    await rm('out/THIRD-PARTY-NOTICES.txt', { force: true });
    await generateLicenseFile('package.json', 'out/THIRD-PARTY-NOTICES.txt', { lineEnding: 'lf' });
    await rm('out/extension.js.map', { force: true });
    await build(options);
}
