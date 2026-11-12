const path = require('node:path');

const { build } = require('esbuild');

async function main() {
    const workspace = process.argv[2] ?? process.env.ALWF_REPRESENTATIVE_WORKSPACE;
    if (!workspace) {
        throw new Error('Pass the original unitop .code-workspace path or set ALWF_REPRESENTATIVE_WORKSPACE. This check reads only the workspace and directly listed manifests.');
    }
    const output = path.resolve(__dirname, '..', 'out', 'representative.cjs');
    await build({ entryPoints: [path.join(__dirname, 'representative.ts')], outfile: output, bundle: true, platform: 'node', mainFields: ['module', 'main'], format: 'cjs', target: 'node22', logLevel: 'warning' });
    const { checkRepresentative } = require(output);
    await checkRepresentative(workspace);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
