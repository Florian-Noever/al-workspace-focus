const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { build } = require('esbuild');

const { createFixture } = require('./fixture.cjs');

async function prepare({ directory, authority = '', kind = 'workspace' } = {}) {
    const root = directory ?? await mkdtemp(path.join(tmpdir(), 'alwf-smoke-spaces & paths-'));
    const fixture = await createFixture(path.resolve(root), { authority, kind });
    const driver = path.join(fixture.directory, 'driver');
    await mkdir(path.join(driver, 'out'), { recursive: true });
    await writeFile(path.join(driver, 'package.json'), JSON.stringify({
        name: 'al-workspace-focus-smoke-driver',
        displayName: 'AL Workspace Focus owned smoke driver',
        publisher: 'al-workspace-focus-tests',
        version: '0.0.0',
        engines: { vscode: '^1.134.0' },
        browser: './out/driver.js',
        activationEvents: ['*'],
        capabilities: { untrustedWorkspaces: { supported: true }, virtualWorkspaces: { supported: false } }
    }, null, 4) + '\n');
    await writeFile(path.join(driver, 'control.json'), JSON.stringify(fixture.control, null, 4) + '\n');
    await build({ entryPoints: [path.join(__dirname, 'smokeDriver.ts')], outfile: path.join(driver, 'out', 'driver.js'), bundle: true, platform: 'browser', mainFields: ['browser', 'module', 'main'], format: 'cjs', target: 'es2022', external: ['vscode'], logLevel: 'warning' });
    return { ...fixture, driver, controlFile: path.join(driver, 'control.json') };
}

module.exports = { prepare };

if (require.main === module) {
    function option(name) {
        const index = process.argv.indexOf(name);
        return index === -1 ? undefined : process.argv[index + 1];
    }
    prepare({ directory: option('--directory'), authority: option('--remote-authority') ?? '', kind: process.argv.includes('--folder') ? 'folder' : 'workspace' }).then(fixture => {
        console.log(JSON.stringify({ fixtureDirectory: fixture.directory, driverDirectory: fixture.driver, controlFile: fixture.controlFile, originalUri: fixture.control.originUri, expectedAppCount: fixture.control.expectedAppCount, expectedRootCount: fixture.control.expectedRootCount }));
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
