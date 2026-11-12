import { beforeEach, describe, expect, it } from 'vitest';

import { resolveFocus } from '../../src/al/dependencyGraph';
import { digest, ensureDirectory, readOptional } from '../../src/host/browserHost';
import { ensureCacheRoot } from '../../src/services/cacheFolders';
import { FocusCache } from '../../src/services/focusCache';
import { WorkspaceUris } from '../../src/services/workspaceOrigin';
import { BROWSER_CACHE_DIRECTORY } from '../../src/shared/settings';
import { sourceIdentity } from '../../src/workspace/cacheInputs';
import { parseMetadata } from '../../src/workspace/cacheMetadata';
import { transformWorkspace } from '../../src/workspace/workspaceTransform';
import { appId, catalogFixture, rootFixture } from '../support/fixtures';
import { FileType, memoryFiles, resetVscode, setFile, Uri, window, workspace } from '../support/vscodeMock';

beforeEach(() => {
    resetVscode();
});

function fixture() {
    const catalog = catalogFixture([rootFixture(0, 'WMS'), rootFixture(1, 'Other'), rootFixture(2, '.resources', { id: null })]);
    const uris = new WorkspaceUris({ scheme: 'file', authority: '' });
    const cache = new FocusCache(uris);
    const base = Uri.parse('file:///repo');
    setFile(base, '', FileType.Directory);
    setFile(Uri.parse(catalog.origin.uri), catalog.workspaceText);
    setFile(Uri.joinPath(base, '.gitignore'), '# User-owned rules\nbin/\n');
    const selection = resolveFocus(catalog, [appId(1)], { includeTests: false });
    const generate = (signal = new AbortController().signal) => cache.getOrCreate(catalog, selection, signal);
    return { cache, catalog, uris, base, generate };
}

function text(uri: string): string {
    const file = memoryFiles().get(uri);
    if (file === undefined) {
        throw new Error(`Missing test file ${uri}`);
    }
    return new TextDecoder().decode(file.bytes);
}

function sidecar(uri: string): Uri {
    return Uri.joinPath(Uri.parse(uri), '..', 'focus.json');
}

function relocate(workspaceUri: string, target: string): string {
    const source = Uri.joinPath(Uri.parse(workspaceUri), '../../../..').toString();
    for (const [uri, file] of [...memoryFiles()]) {
        if (uri === source || uri.startsWith(`${source}/`)) {
            setFile(Uri.parse(target + uri.slice(source.length)), new TextDecoder().decode(file.bytes), file.type);
        }
    }
    return target + workspaceUri.slice(source.length);
}

describe('automatic browser filesystem cache', () => {
    it('checks existing cache ancestors before recursively creating a missing selection', async () => {
        const root = Uri.parse(`file:///private-cache/${BROWSER_CACHE_DIRECTORY}`);
        setFile(root, '', FileType.Directory);
        setFile(Uri.joinPath(root, 'source'), '', FileType.Directory | FileType.SymbolicLink);
        await expect(ensureDirectory(root, Uri.joinPath(root, 'source', 'selection'))).rejects.toThrow(/link/);
        await expect(ensureDirectory(root, Uri.parse('file:///outside-cache'))).rejects.toThrow(/outside/);
        expect(workspace.fs.createDirectory).not.toHaveBeenCalled();
    });

    it('avoids listing an initially absent selection but checks existing entries on the next focus', async () => {
        const { generate } = fixture();
        const first = await generate();
        expect(first.hit).toBe(false);
        expect(workspace.fs.readDirectory).not.toHaveBeenCalled();
        expect((await generate()).hit).toBe(true);
        expect(workspace.fs.readDirectory).toHaveBeenCalledOnce();
    });

    it('matches standard SHA-256 vectors for text and bytes using Web Crypto', async () => {
        const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
        expect(await digest('abc')).toBe(expected);
        expect(await digest(new TextEncoder().encode('abc'))).toBe(expected);
    });

    it('creates self-ignored storage only when needed, without a picker or changes to tracked ignore rules', async () => {
        const { cache, generate } = fixture();
        await cache.recognize('file:///repo/source.code-workspace');
        expect(window.showOpenDialog).not.toHaveBeenCalled();
        const first = await generate();
        expect(first.hit).toBe(false);
        expect(window.showOpenDialog).not.toHaveBeenCalled();
        expect(text(`file:///repo/${BROWSER_CACHE_DIRECTORY}/.gitignore`)).toBe('*\n');
        expect(text('file:///repo/.gitignore')).toBe('# User-owned rules\nbin/\n');
        const writes = workspace.fs.writeFile.mock.calls.length;
        const next = await generate();
        expect(next.hit).toBe(true);
        expect(next.active.workspaceUri).toBe(first.active.workspaceUri);
        expect(workspace.fs.writeFile).toHaveBeenCalledTimes(writes);
        expect(window.showOpenDialog).not.toHaveBeenCalled();
        expect(await cache.recognize(first.active.workspaceUri)).toMatchObject({ candidate: true, active: { modified: false } });
    });

    it('never writes source resources and separates selections and changed manifests', async () => {
        const { cache, catalog, generate } = fixture();
        const first = await generate();
        const other = await cache.getOrCreate(catalog, resolveFocus(catalog, [appId(2)], { includeTests: false }), new AbortController().signal);
        const changed = { ...catalog, workspaceText: `${catalog.workspaceText}// changed\n` };
        const modified = await cache.getOrCreate(changed, resolveFocus(changed, [appId(1)], { includeTests: false }), new AbortController().signal);
        expect(other.active.workspaceUri).not.toBe(first.active.workspaceUri);
        expect(modified.active.workspaceUri).not.toBe(first.active.workspaceUri);
        expect(text(catalog.origin.uri)).toBe(catalog.workspaceText);
        expect(workspace.fs.writeFile.mock.calls.every(([uri]) => uri.path.startsWith(`/repo/${BROWSER_CACHE_DIRECTORY}/`))).toBe(true);
        expect(text('file:///repo/.gitignore')).toBe('# User-owned rules\nbin/\n');
    });

    it('preserves edited workspaces and reuses another intact entry', async () => {
        const { cache, generate } = fixture();
        const first = await generate();
        const edited = `${text(first.active.workspaceUri)}// user edit\n`;
        setFile(Uri.parse(first.active.workspaceUri), edited);
        expect(await cache.recognize(first.active.workspaceUri)).toMatchObject({ active: { modified: true } });
        const replacement = await generate();
        expect(replacement.active.workspaceUri).not.toBe(first.active.workspaceUri);
        expect(text(first.active.workspaceUri)).toBe(edited);
        expect((await generate()).active.workspaceUri).toBe(replacement.active.workspaceUri);
    });

    it('preserves corrupt and incomplete sidecars instead of overwriting them', async () => {
        const { cache, generate } = fixture();
        const first = await generate();
        const metadata = sidecar(first.active.workspaceUri);
        setFile(metadata, '{"owner":"other"}');
        expect(await cache.recognize(first.active.workspaceUri)).toMatchObject({ active: null, candidate: true });
        const other = await generate();
        expect(other.active.workspaceUri).not.toBe(first.active.workspaceUri);
        expect(text(metadata.toString())).toBe('{"owner":"other"}');
    });

    it('recognizes an entry without shared profile state and never fabricates an origin from naming', async () => {
        const { cache, generate, uris } = fixture();
        const first = await generate();
        expect(await new FocusCache(uris).recognize(first.active.workspaceUri)).toMatchObject({ candidate: true, active: { modified: false } });
        const stray = `file:///stray/${BROWSER_CACHE_DIRECTORY}/source.code-workspace`;
        setFile(Uri.parse(stray), '{"folders":[]}');
        expect(await cache.recognize(stray)).toMatchObject({ candidate: true, active: null });
        expect(await cache.recognize('file:///ordinary/source.code-workspace')).toMatchObject({ candidate: false });
        expect(await cache.recognize('file:///private/al-workspace-focus-browser-v1/a/b/c/focus.code-workspace')).toMatchObject({ candidate: false });
    });

    it('permits immutable concurrent duplicates without overwriting another operation', async () => {
        const { generate, cache } = fixture();
        const entries = await Promise.all(Array.from({ length: 5 }, () => generate()));
        for (const entry of entries) {
            expect(await cache.recognize(entry.active.workspaceUri)).toMatchObject({ active: { modified: false } });
        }
        expect(new Set(workspace.fs.writeFile.mock.calls.filter(([uri]) => uri.path.endsWith('/focus.code-workspace')).map(([uri]) => uri.toString())).size).toBe(entries.filter(entry => !entry.hit).length);
        const reused = await generate();
        expect(entries.some(entry => entry.active.workspaceUri === reused.active.workspaceUri)).toBe(true);
        const current = entries.at(-1);
        if (current === undefined) {
            throw new Error('Missing concurrent test result');
        }
        workspace.workspaceFile = Uri.parse(current.active.workspaceUri);
        expect((await generate()).active.workspaceUri).toBe(current.active.workspaceUri);
    });

    it('cleans the losing temporary ignore file when two windows use the same workspace', async () => {
        const { catalog } = fixture();
        const chosen = await Promise.all(Array.from({ length: 2 }, () => ensureCacheRoot(catalog.origin, new AbortController().signal)));
        expect(chosen.map(root => root.toString())).toEqual(Array.from({ length: 2 }, () => `file:///repo/${BROWSER_CACHE_DIRECTORY}`));
        expect(workspace.fs.rename).toHaveBeenCalledTimes(2);
        expect(text(`file:///repo/${BROWSER_CACHE_DIRECTORY}/.gitignore`)).toBe('*\n');
        expect([...memoryFiles().keys()].some(uri => uri.endsWith('.tmp'))).toBe(false);
    });

    it('cleans cancellation after writing the workspace without publishing a sidecar', async () => {
        const { generate } = fixture();
        const operation = new AbortController();
        const original = workspace.fs.writeFile.getMockImplementation();
        if (original === undefined) {
            throw new Error('Missing filesystem write fixture');
        }
        workspace.fs.writeFile.mockImplementation(async (uri, bytes) => {
            await original(uri, bytes);
            if (uri.path.endsWith('/focus.code-workspace')) {
                operation.abort();
            }
        });
        await expect(generate(operation.signal)).rejects.toThrow();
        expect([...memoryFiles().keys()].some(uri => /\/(stage\.json|focus\.code-workspace|focus\.json)$/.test(uri))).toBe(false);
    });

    it('preserves a modified cache ignore file rather than overwriting it or publishing an unignored workspace', async () => {
        const { generate } = fixture();
        setFile(Uri.parse(`file:///repo/${BROWSER_CACHE_DIRECTORY}`), '', FileType.Directory);
        const ignore = Uri.parse(`file:///repo/${BROWSER_CACHE_DIRECTORY}/.gitignore`);
        setFile(ignore, '!important.json\n');
        await expect(generate()).rejects.toThrow(/modified and has been preserved/);
        expect(text(ignore.toString())).toBe('!important.json\n');
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(window.showOpenDialog).not.toHaveBeenCalled();
    });

    it('writes the completion sidecar last and cleans an owned incomplete write failure', async () => {
        const { generate } = fixture();
        const original = workspace.fs.writeFile.getMockImplementation();
        if (original === undefined) {
            throw new Error('Missing filesystem write fixture');
        }
        workspace.fs.writeFile.mockImplementation((uri, bytes) => uri.path.endsWith('/focus.json') ? Promise.reject(new Error('Interrupted metadata write')) : original(uri, bytes));
        await expect(generate()).rejects.toThrow('Interrupted metadata write');
        expect([...memoryFiles().keys()].some(uri => /\/(stage\.json|focus\.code-workspace)$/.test(uri))).toBe(false);
        expect(workspace.fs.writeFile.mock.calls.map(([uri]) => uri.path.slice(uri.path.lastIndexOf('/') + 1)).filter(name => !name.endsWith('.tmp'))).toEqual(['stage.json', 'focus.code-workspace', 'focus.json']);
    });

    it('surfaces ownership/cleanup failures without deleting unexpected content', async () => {
        const { generate } = fixture();
        const original = workspace.fs.writeFile.getMockImplementation();
        if (original === undefined) {
            throw new Error('Missing filesystem write fixture');
        }
        workspace.fs.writeFile.mockImplementation(async (uri, bytes) => {
            await original(uri, bytes);
            if (uri.path.endsWith('/focus.code-workspace')) {
                setFile(Uri.joinPath(uri, '..', 'stage.json'), '{"owner":"changed"}');
                throw new Error('Write interrupted');
            }
        });
        await expect(generate()).rejects.toThrow(AggregateError);
        expect([...memoryFiles().keys()].some(uri => uri.endsWith('/focus.code-workspace'))).toBe(true);
    });

    it('rejects read-only or linked automatic caches without asking for a replacement folder', async () => {
        const { generate } = fixture();
        workspace.fs.isWritableFileSystem.mockReturnValue(false);
        await expect(generate()).rejects.toThrow(/read-only/);
        workspace.fs.isWritableFileSystem.mockReturnValue(true);
        setFile(Uri.parse(`file:///repo/${BROWSER_CACHE_DIRECTORY}`), '', FileType.Directory | FileType.SymbolicLink);
        await expect(generate()).rejects.toThrow(/link/);
        expect(window.showOpenDialog).not.toHaveBeenCalled();
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it('aborts cancelled automatic cache operations without writing', async () => {
        const { generate } = fixture();
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(generate(cancelled.signal)).rejects.toThrow();
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(window.showOpenDialog).not.toHaveBeenCalled();
    });

    it('cleans a cancelled ignore-file publication without caching workspace configuration', async () => {
        const { generate } = fixture();
        const operation = new AbortController();
        const write = workspace.fs.writeFile.getMockImplementation();
        if (write === undefined) {
            throw new Error('Missing filesystem write fixture');
        }
        workspace.fs.writeFile.mockImplementation(async (uri, bytes) => {
            await write(uri, bytes);
            if (uri.path.endsWith('.tmp')) {
                operation.abort();
            }
        });
        await expect(generate(operation.signal)).rejects.toThrow();
        expect([...memoryFiles().keys()].some(uri => uri.endsWith('.tmp') || uri.endsWith('/focus.code-workspace') || uri.endsWith('/focus.json'))).toBe(false);
        expect(text('file:///repo/.gitignore')).toBe('# User-owned rules\nbin/\n');
    });

    it('refuses a linked cache ignore file without modifying it or its target', async () => {
        const { generate } = fixture();
        setFile(Uri.parse(`file:///repo/${BROWSER_CACHE_DIRECTORY}`), '', FileType.Directory);
        setFile(Uri.parse(`file:///repo/${BROWSER_CACHE_DIRECTORY}/.gitignore`), 'linked contents', FileType.File | FileType.SymbolicLink);
        await expect(generate()).rejects.toThrow(/link/);
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(text(`file:///repo/${BROWSER_CACHE_DIRECTORY}/.gitignore`)).toBe('linked contents');
    });

    it.each([true, false])('preserves unsaved cache ignore edits whether the file already exists: %s', async exists => {
        const { generate } = fixture();
        const ignore = Uri.parse(`file:///repo/${BROWSER_CACHE_DIRECTORY}/.gitignore`);
        if (exists) {
            setFile(ignore, '*\n');
        }
        workspace.textDocuments = [{ uri: ignore, isDirty: true }];
        await expect(generate()).rejects.toMatchObject({ code: 'dirty-cache-file' });
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(window.showOpenDialog).not.toHaveBeenCalled();
    });

    it('places a folder-origin cache inside the actual app folder, including reparse-backed source folders', async () => {
        const { cache, catalog, base } = fixture();
        setFile(base, '', FileType.Directory | FileType.SymbolicLink);
        const root = catalog.roots[0];
        if (root === undefined) {
            throw new Error('Missing app folder fixture');
        }
        const folder = Uri.parse(root.uri);
        setFile(folder, '', FileType.Directory | FileType.SymbolicLink);
        const folderCatalog = catalogFixture([root], {}, { kind: 'folder', uri: folder.toString(), label: 'WMS' });
        const result = await cache.getOrCreate(folderCatalog, resolveFocus(folderCatalog, [appId(1)], { includeTests: false }), new AbortController().signal);
        expect(result.active.workspaceUri.startsWith(`${folder.toString()}/${BROWSER_CACHE_DIRECTORY}/`)).toBe(true);
        expect(text(`${folder.toString()}/${BROWSER_CACHE_DIRECTORY}/.gitignore`)).toBe('*\n');
        expect(window.showOpenDialog).not.toHaveBeenCalled();
    });

    it('creates the cache on the original remote authority and writes nothing to the client profile', async () => {
        const { catalog } = fixture();
        const authority = 'ssh-remote+fixture';
        setFile(Uri.parse(`vscode-remote://${authority}/home/repo`), '', FileType.Directory);
        const root = await ensureCacheRoot({ ...catalog.origin, uri: `vscode-remote://${authority}/home/repo/source.code-workspace` }, new AbortController().signal);
        expect(root.toString()).toBe(`vscode-remote://${authority}/home/repo/${BROWSER_CACHE_DIRECTORY}`);
        expect(text(`${root.toString()}/.gitignore`)).toBe('*\n');
        expect(workspace.fs.writeFile.mock.calls.every(([uri]) => uri.authority === authority)).toBe(true);
    });

    it('rejects oversized or linked cache files and retains them', async () => {
        const { generate, cache } = fixture();
        const first = await generate();
        setFile(sidecar(first.active.workspaceUri), 'x'.repeat(1024 * 1024 + 1));
        expect(await cache.recognize(first.active.workspaceUri)).toMatchObject({ active: null });
        const linked = Uri.parse(`file:///repo/${BROWSER_CACHE_DIRECTORY}/linked`);
        setFile(linked, 'text', FileType.File | FileType.SymbolicLink);
        await expect(readOptional(linked, 100)).rejects.toThrow(/link/);
    });
});

describe('cache entries bound to the origin beside them', () => {
    it('rejects an entry relocated under another cache folder', async () => {
        const { cache, generate } = fixture();
        const first = await generate();
        setFile(Uri.parse('file:///elsewhere'), '', FileType.Directory);
        const moved = await cache.recognize(relocate(first.active.workspaceUri, `file:///elsewhere/${BROWSER_CACHE_DIRECTORY}`));
        expect(moved).toMatchObject({ candidate: true, active: null });
        expect(moved.diagnostic).toContain('cache location');
        expect(await cache.recognize(first.active.workspaceUri)).toMatchObject({ active: { modified: false } });
    });

    it('rejects a forged entry whose self-consistent hashes name an origin elsewhere', async () => {
        const { cache, generate } = fixture();
        const first = await generate();
        const origin = { kind: 'workspace' as const, uri: 'file:///elsewhere/other.code-workspace', label: 'other.code-workspace' };
        const root = `file:///repo/${BROWSER_CACHE_DIRECTORY}`;
        const hostFingerprint = await digest(JSON.stringify({ scheme: 'file', authority: '', cacheRoot: root }));
        const sourceKey = await digest(sourceIdentity(origin, hostFingerprint));
        const forged = { ...parseMetadata(text(sidecar(first.active.workspaceUri).toString())), origin, hostFingerprint, sourceKey };
        const entry = `${root}/${sourceKey}/${forged.inputHash}/${'cd'.repeat(16)}`;
        for (const depth of [0, 1, 2]) {
            setFile(Uri.joinPath(Uri.parse(entry), ...Array.from({ length: depth }, () => '..')), '', FileType.Directory);
        }
        setFile(Uri.parse(`${entry}/focus.code-workspace`), text(first.active.workspaceUri));
        setFile(Uri.parse(`${entry}/focus.json`), JSON.stringify(forged));
        const state = await cache.recognize(`${entry}/focus.code-workspace`);
        expect(state).toMatchObject({ candidate: true, active: null });
        expect(state.diagnostic).toContain('cache location');
    });

    it('rejects a workspace at the wrong depth inside the cache folder', async () => {
        const { cache, generate } = fixture();
        const first = await generate();
        const shallow = Uri.joinPath(Uri.parse(first.active.workspaceUri), '../..', 'focus.code-workspace');
        setFile(shallow, text(first.active.workspaceUri));
        expect(await cache.recognize(shallow.toString())).toMatchObject({ candidate: true, active: null });
    });

    it('accepts an entry reopened through a differently cased Windows path', async () => {
        const cache = new FocusCache(new WorkspaceUris({ scheme: 'file', authority: '' }));
        const origin = { kind: 'workspace' as const, uri: 'file:///C:/Repo/source.code-workspace', label: 'source.code-workspace' };
        const catalog = catalogFixture([rootFixture(0, 'WMS')], {}, origin);
        setFile(Uri.parse('file:///C:/Repo'), '', FileType.Directory);
        const created = await cache.getOrCreate(catalog, resolveFocus(catalog, [appId(1)], { includeTests: false }), new AbortController().signal);
        const reopened = relocate(created.active.workspaceUri, `file:///c:/repo/${BROWSER_CACHE_DIRECTORY}`);
        expect(await cache.recognize(reopened)).toMatchObject({ active: { modified: false, metadata: { origin } } });
    });
});

describe('compatibility with entries written by 0.5.x', () => {
    const written = {
        owner: 'al-workspace-focus',
        formatVersion: 2,
        transformVersion: 1,
        pathPolicy: 'context-aware-v1',
        hostFingerprint: 'b5585185e57c871d2af96f2a4eb2aaa9835f508df2827a791897b7212f3821c2',
        sourceKey: 'ca6968e4c50c2afae2b8fc30bb7138a41fd993fcab11f2d0523d759c3c045795',
        inputHash: '6e4bfff7fc4fa8033a2a95a33ee7fbb9bcbcc7ede988747e56c9b68a884711f8',
        workspaceDigest: 'de9fe58f9cc59b724a577f1d3548cc3b34dc7a0a3f4ee0670065d721a78d47b9',
        origin: { kind: 'workspace', uri: 'file:///repo/source.code-workspace', label: 'source.code-workspace' },
        selectedIds: ['00000000-0000-0000-0000-000000000001'],
        selectedNames: ['WMS'],
        options: { includeTests: false },
        roots: ['WMS', '.resources'],
        appCount: 1
    };

    it('recognizes and reuses an existing entry without rewriting it', async () => {
        const { cache, catalog, generate } = fixture();
        const entry = `file:///repo/${BROWSER_CACHE_DIRECTORY}/${written.sourceKey}/${written.inputHash}/${'ab'.repeat(16)}`;
        for (const depth of [0, 1, 2, 3]) {
            setFile(Uri.joinPath(Uri.parse(entry), ...Array.from({ length: depth }, () => '..')), '', FileType.Directory);
        }
        setFile(Uri.parse(`file:///repo/${BROWSER_CACHE_DIRECTORY}/.gitignore`), '*\n');
        setFile(Uri.parse(`${entry}/focus.code-workspace`), transformWorkspace(catalog, resolveFocus(catalog, [appId(1)], { includeTests: false })).text);
        setFile(Uri.parse(`${entry}/focus.json`), JSON.stringify(written, null, 4) + '\n');
        const reused = await generate();
        expect(reused).toMatchObject({ hit: true, active: { workspaceUri: `${entry}/focus.code-workspace`, modified: false } });
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(await cache.recognize(reused.active.workspaceUri)).toMatchObject({ active: { modified: false, metadata: written } });
    });

    it.each([
        ['folder', { kind: 'folder', uri: 'file:///repo/WMS', label: 'WMS' }, 'file', '', 'file:///repo/WMS', '28d69c4bccab463abd68d3e29552c101102511963d690961b8aa183ee356cfd9/856135c7b9da64600bdb7f7b9d95e73cba11171c9f9525cdfa44fb934b41ccab'],
        ['remote', { kind: 'workspace', uri: 'vscode-remote://ssh-remote+fixture/home/repo/source.code-workspace', label: 'source.code-workspace' }, 'vscode-remote', 'ssh-remote+fixture', 'vscode-remote://ssh-remote+fixture/home/repo', '93e3327d2c86cc9d17b8ea305e91b9784abd9c380ff89ab2655d3276240032d5/d26c08567408620b6c17da55da7430d47d4146cf5f538ab05f3237a167364756'],
        ['drive-root', { kind: 'workspace', uri: 'file:///C:/source.code-workspace', label: 'source.code-workspace' }, 'file', '', 'file:///C:/', '724ff1fdb4b8344951ab5f40a9073be66967784d745ae3b71beae22f90bab78f/08de9ca3345a9be5a3281f48ed5328794feb539db52046c9b22cb7574cc0630e'],
        ['UNC', { kind: 'workspace', uri: 'file://server/share/repo/source.code-workspace', label: 'source.code-workspace' }, 'file', '', 'file://server/share/repo', 'bd02d2d46ffd10b544748a67c284b07c173dcf458a2a1eb81ca33a4af80f03ca/483b9cd72531d66c8e7932850f8badf7897b4e5a83ffc832bbbedf7df161663d']
    ] as const)('keeps the source and selection identity of a %s origin', async (_shape, origin, scheme, authority, base, identity) => {
        const cache = new FocusCache(new WorkspaceUris({ scheme, authority }));
        const catalog = catalogFixture(origin.kind === 'folder' ? [rootFixture(0, 'WMS')] : [rootFixture(0, 'WMS'), rootFixture(1, 'Other'), rootFixture(2, '.resources', { id: null })], {}, origin);
        setFile(Uri.parse(base), '', FileType.Directory);
        const result = await cache.getOrCreate(catalog, resolveFocus(catalog, [appId(1)], { includeTests: false }), new AbortController().signal);
        expect(result.active.workspaceUri.split('/').slice(-4, -2).join('/')).toBe(identity);
        expect(await cache.recognize(result.active.workspaceUri)).toMatchObject({ active: { modified: false, metadata: { origin } } });
    });
});
