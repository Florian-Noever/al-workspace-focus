const { copyFile, mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');

function fileUri(file) {
    const url = pathToFileURL(file);
    const pathname = url.pathname.replace(/^\/([A-Z]):/, (_match, drive) => `/${drive.toLowerCase()}:`);
    return `file://${url.host}${pathname.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/')}`;
}

async function installProduction(repository, extensions) {
    const manifest = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
    const directory = path.join(extensions, `${manifest.publisher.toLowerCase()}.${manifest.name}-${manifest.version}`);
    if (typeof manifest.icon !== 'string') {
        throw new Error('The production manifest has no icon path');
    }
    await Promise.all(['package.json', 'out/extension.js', manifest.icon].map(async file => {
        const destination = path.join(directory, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(repository, file), destination);
    }));
    const registry = path.join(extensions, 'extensions.json');
    let entries;
    try {
        entries = JSON.parse(await readFile(registry, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
    if (entries) {
        const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
        const url = new globalThis.URL(fileUri(directory));
        entries = entries.filter(entry => entry.identifier.id.toLowerCase() !== id);
        entries.push({ identifier: { id }, version: manifest.version, location: { $mid: 1, scheme: 'file', path: decodeURIComponent(url.pathname) }, relativeLocation: path.basename(directory), metadata: { source: 'vsix', installedTimestamp: Date.now(), pinned: true } });
        await writeFile(registry, JSON.stringify(entries) + '\n');
    }
    return directory;
}

async function installDriver(source, directory, name, control) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({
        name, publisher: 'al-workspace-focus-tests', version: '0.0.0', engines: { vscode: '^1.134.0' },
        browser: './driver.js', activationEvents: ['*'], capabilities: { untrustedWorkspaces: { supported: true }, virtualWorkspaces: false }
    }, null, 4) + '\n');
    await writeFile(path.join(directory, 'control.json'), JSON.stringify(control, null, 4) + '\n');
    await build({ entryPoints: [source], outfile: path.join(directory, 'driver.js'), bundle: true, platform: 'browser', mainFields: ['browser', 'module', 'main'], format: 'cjs', target: 'es2022', external: ['vscode'], logLevel: 'warning' });
}

async function optionalJson(file) {
    try {
        const text = await readFile(file, 'utf8');
        try {
            return JSON.parse(text);
        } catch (error) {
            if (error instanceof SyntaxError) {
                return null;
            }
            throw error;
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

module.exports = { fileUri, installProduction, installDriver, optionalJson };
