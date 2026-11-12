const { createHash, randomBytes } = require('node:crypto');
const { lstat, mkdir, readFile, readdir, realpath, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function uriFor(file, authority = '') {
    const local = pathToFileURL(file);
    return authority.length === 0 ? local.toString() : `vscode-remote://${authority}${local.pathname}`;
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function createFixture(requestedDirectory, { authority = '', kind = 'workspace' } = {}) {
    if (!path.basename(requestedDirectory).startsWith('alwf-')) {
        throw new Error('Integration fixtures must use an explicitly owned alwf- directory.');
    }
    await mkdir(requestedDirectory, { recursive: true });
    if ((await lstat(requestedDirectory)).isSymbolicLink()) {
        throw new Error('An owned integration fixture root cannot be a symbolic link.');
    }
    const directory = await realpath(requestedDirectory);
    if ((await readdir(directory)).length > 0) {
        throw new Error('Refusing to overwrite a nonempty integration fixture directory.');
    }
    const token = randomBytes(16).toString('hex');
    const identities = [
        { folder: 'Base', id: '00000000-0000-0000-0000-000000000001', name: 'Base', dependencies: [] },
        { folder: 'WMS', id: '00000000-0000-0000-0000-000000000002', name: 'Warehouse Management', dependencies: [{ id: '00000000-0000-0000-0000-000000000001', name: 'Base', publisher: 'Fixture', version: '1.0.0.0' }] },
        { folder: 'Other', id: '00000000-0000-0000-0000-000000000003', name: 'Other', dependencies: [] },
        { folder: 'WMS Test', id: '00000000-0000-0000-0000-000000000004', name: 'Warehouse Management Test', dependencies: [{ appId: '00000000-0000-0000-0000-000000000001', name: 'Base', publisher: 'Fixture', version: '1.0.0.0' }] }
    ];
    const sourceFiles = [];
    await writeFile(path.join(directory, '.alwf-fixture.json'), JSON.stringify({ owner: 'al-workspace-focus-smoke', token }) + '\n', { flag: 'wx', mode: 0o600 });
    for (const identity of identities) {
        const folder = path.join(directory, 'apps', identity.folder);
        await mkdir(folder, { recursive: true });
        const manifest = path.join(folder, 'app.json');
        await writeFile(manifest, JSON.stringify({ id: identity.id, name: identity.name, publisher: 'Fixture', version: '1.0.0.0', dependencies: identity.dependencies }, null, 4) + '\n');
        const ruleset = path.join(folder, 'ruleset.json');
        await writeFile(ruleset, '{"name":"Fixture","rules":[]}\n');
        sourceFiles.push(manifest, ruleset);
    }
    for (const folder of ['apps/.resources', 'apps/.alpackages', 'AI-Tools']) {
        await mkdir(path.join(directory, folder), { recursive: true });
    }
    const workspaceFile = path.join(directory, 'source.code-workspace');
    const text = '// Owned AL Workspace Focus smoke fixture\n' + JSON.stringify({
        folders: [
            ...identities.map(identity => ({ path: `apps/${identity.folder}`, name: identity.folder, fixtureAttribute: true })),
            { path: 'apps/.resources', name: 'Resources' },
            { path: 'apps/.alpackages', name: 'Packages' },
            { path: 'AI-Tools' }
        ],
        settings: {
            'al.packageCachePath': './../.alpackages',
            'al.ruleSetPath': './ruleset.json',
            'alWorkspaceFocus.includeTests': false,
            'files.eol': '\r\n'
        },
        extensions: { recommendations: ['ms-dynamics-smb.al'] },
        launch: { configurations: [{ name: 'Fixture', type: 'al', request: 'launch', startupObjectId: 1, startupObjectType: 'Page' }] },
        tasks: { version: '2.0.0', tasks: [{ label: 'Fixture', type: 'shell', command: 'echo', args: ['/c'], options: { cwd: '${workspaceFolder:WMS}' } }] },
        fixtureRootAttribute: { preserved: true }
    }, null, 4) + '\n';
    await writeFile(workspaceFile, text);
    sourceFiles.push(workspaceFile);
    const selectedFolder = kind === 'folder' ? 'Base' : 'WMS';
    const original = kind === 'folder' ? path.join(directory, 'apps', 'Base') : workspaceFile;
    const sourceDigests = await Promise.all(sourceFiles.map(async file => ({ uri: uriFor(file, authority), digest: sha256(await readFile(file)) })));
    const control = {
        owner: 'al-workspace-focus-smoke',
        token,
        fixtureUri: uriFor(directory, authority),
        originKind: kind,
        originUri: uriFor(original, authority),
        focusAppUri: uriFor(path.join(directory, 'apps', selectedFolder, 'app.json'), authority),
        expectedAppCount: kind === 'folder' ? 1 : 2,
        expectedRootCount: kind === 'folder' ? 1 : 5,
        sourceDigests,
        phase: 'focus',
        status: 'running',
        cacheUri: null,
        workspaceMtime: null,
        metadataMtime: null,
        hostVersion: null,
        remoteName: null,
        message: null,
        journeys: []
    };
    return { directory, original, workspaceFile, control, sourceFiles };
}

module.exports = { createFixture, sha256, uriFor };
