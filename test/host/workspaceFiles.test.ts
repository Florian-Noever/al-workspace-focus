import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { containsUri, sameUri } from '../../src/host/browserHost';
import { WorkspaceFiles } from '../../src/services/workspaceFiles';
import { currentOrigin, filesystemHost, WorkspaceUris } from '../../src/services/workspaceOrigin';
import { appId, manifestText } from '../support/fixtures';
import { FileSystemError, FileType, resetVscode, setFile, setUriPlatform, Uri, workspace } from '../support/vscodeMock';

import type { WorkspaceOrigin } from '../../src/shared/focusTypes';

const base = path.join(tmpdir(), 'alwf-source-mock');
const sourceUri = Uri.file(path.join(base, 'source.code-workspace'));
const origin: WorkspaceOrigin = { kind: 'workspace', uri: sourceUri.toString(), label: 'Source' };

beforeEach(() => {
    resetVscode();
});

function sourceFixture(): { readonly files: WorkspaceFiles; readonly uris: WorkspaceUris } {
    const uris = new WorkspaceUris({ scheme: 'file', authority: '' });
    setFile(sourceUri, JSON.stringify({ folders: [{ path: 'WMS', name: 'Warehouse', custom: 17 }, { path: '.resources' }] }));
    setFile(Uri.file(path.join(base, 'WMS')), '', FileType.Directory | FileType.SymbolicLink);
    setFile(Uri.file(path.join(base, 'WMS', 'app.json')), manifestText());
    setFile(Uri.file(path.join(base, '.resources')), '', FileType.Directory);
    workspace.workspaceFile = sourceUri;
    return { files: new WorkspaceFiles(uris), uris };
}

describe('source origins and direct-root catalogue I/O', () => {
    it('reads only directly listed manifests, preserving names/attributes and reparse-backed roots', async () => {
        const { files } = sourceFixture();
        const catalog = await files.load(origin, new AbortController().signal);
        expect(catalog.apps).toHaveLength(1);
        expect(catalog.roots).toHaveLength(2);
        expect(catalog.roots[0]?.name).toBe('Warehouse');
        expect(catalog.roots[0]?.entry.custom).toBe(17);
        expect(catalog.roots[1]?.manifestText).toBeNull();
        expect(workspace.fs.readDirectory).not.toHaveBeenCalled();
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(workspace.fs.delete).not.toHaveBeenCalled();
        expect(workspace.fs.readFile.mock.calls.filter(([uri]) => uri.path.endsWith('/app.json'))).toHaveLength(2);
        expect(workspace.fs.stat.mock.calls.map(([uri]) => uri.toString())).toEqual([Uri.file(path.join(base, '.resources')).toString()]);
    });

    it('continues reading later roots while one early manifest is slow, without unbounded reads or reordering', async () => {
        const { files } = sourceFixture();
        const folders = Array.from({ length: 70 }, (_, index) => ({ path: `App${index.toString()}` }));
        setFile(sourceUri, JSON.stringify({ folders }));
        for (const [index, folder] of folders.entries()) {
            setFile(Uri.file(path.join(base, folder.path, 'app.json')), manifestText({ id: appId(index + 1), name: folder.path }));
        }
        const read = workspace.fs.readFile.getMockImplementation();
        if (read === undefined) {
            throw new Error('Missing filesystem mock');
        }
        let releaseFirst: () => void = () => { throw new Error('The delayed manifest was not initialized'); };
        const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
        const requested = new Set<string>();
        let active = 0;
        let maximum = 0;
        workspace.fs.readFile.mockImplementation(async uri => {
            if (!uri.path.endsWith('/app.json')) {
                return read(uri);
            }
            requested.add(uri.path);
            maximum = Math.max(maximum, ++active);
            try {
                if (uri.path.endsWith('/App0/app.json')) {
                    await blocked;
                }
                return await read(uri);
            } finally {
                active--;
            }
        });
        const loading = files.load(origin, new AbortController().signal);
        try {
            await vi.waitFor(() => {
                expect([...requested].some(uri => uri.endsWith('/App69/app.json'))).toBe(true);
            });
        } finally {
            releaseFirst();
        }
        const catalog = await loading;
        expect(catalog.roots.map(root => root.folderName)).toEqual(folders.map(folder => folder.path));
        expect(maximum).toBeGreaterThan(1);
        expect(maximum).toBeLessThan(folders.length);
    });

    it.each(['failure', 'cancellation'])('stops starting queued reads after %s while preserving in-flight cleanup', async mode => {
        const { files } = sourceFixture();
        const folders = Array.from({ length: 70 }, (_, index) => ({ path: `App${index.toString()}` }));
        setFile(sourceUri, JSON.stringify({ folders }));
        for (const [index, folder] of folders.entries()) {
            setFile(Uri.file(path.join(base, folder.path, 'app.json')), manifestText({ id: appId(index + 1) }));
        }
        const read = workspace.fs.readFile.getMockImplementation();
        if (read === undefined) {
            throw new Error('Missing filesystem mock');
        }
        let release: () => void = () => { throw new Error('Pending read gate not initialized'); };
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const inFlight: Array<Promise<Uint8Array>> = [];
        const requested = new Set<string>();
        workspace.fs.readFile.mockImplementation(uri => {
            if (!uri.path.endsWith('/app.json')) {
                return read(uri);
            }
            requested.add(uri.path);
            if (mode === 'failure' && uri.path.endsWith('/App0/app.json')) {
                return Promise.reject(new FileSystemError('NoPermissions'));
            }
            const pending = blocked.then(() => read(uri));
            inFlight.push(pending);
            return pending;
        });
        const operation = new AbortController();
        const loading = files.load(origin, operation.signal);
        try {
            if (mode === 'cancellation') {
                await vi.waitFor(() => { expect(requested.size).toBeGreaterThan(0); });
                operation.abort();
                await expect(loading).rejects.toThrow();
            } else {
                await expect(loading).rejects.toMatchObject({ code: 'manifest-read' });
            }
            expect(requested.size).toBeLessThan(folders.length);
        } finally {
            release();
            await Promise.allSettled(inFlight);
        }
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it('still rejects a missing manifest when its listed non-app root is a file', async () => {
        const { files } = sourceFixture();
        setFile(Uri.file(path.join(base, '.resources')), 'not a directory');
        await expect(files.load(origin, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-root' });
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it('rejects unsaved source workspace and manifest snapshots without saving them', async () => {
        const { files } = sourceFixture();
        workspace.textDocuments = [{ uri: sourceUri, isDirty: true }];
        await expect(files.load(origin, new AbortController().signal)).rejects.toThrow(/Save the unsaved workspace or app.json/);
        workspace.textDocuments = [{ uri: Uri.file(path.join(base, 'WMS', 'app.json')), isDirty: true }];
        await expect(files.load(origin, new AbortController().signal)).rejects.toThrow(/Save the unsaved workspace or app.json/);
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it('allows unrelated unsaved editors and detects source changes during catalogue reads', async () => {
        const { files } = sourceFixture();
        workspace.textDocuments = [{ uri: Uri.file(path.join(base, 'Example.al')), isDirty: true }];
        await expect(files.load(origin, new AbortController().signal)).resolves.toMatchObject({ apps: [{ manifest: { id: appId(1) } }] });
        const read = workspace.fs.readFile.getMockImplementation();
        if (read === undefined) {
            throw new Error('Missing filesystem mock');
        }
        workspace.fs.readFile.mockImplementation(async uri => {
            if (uri.path.endsWith('/WMS/app.json')) {
                setFile(sourceUri, JSON.stringify({ folders: [{ path: 'WMS' }] }) + '\n// changed\n');
            }
            return read(uri);
        });
        await expect(files.load(origin, new AbortController().signal)).rejects.toThrow(/changed while its catalog/);
    });

    it('gives an actionable explanation for a repository folder that is not itself an app', async () => {
        const { files } = sourceFixture();
        const folder = Uri.file(base);
        setFile(folder, '', FileType.Directory);
        await expect(files.load({ kind: 'folder', uri: folder.toString(), label: 'Repo' }, new AbortController().signal)).rejects.toThrow(/multi-root.*does not recursively scan/);
        expect(workspace.fs.readDirectory).not.toHaveBeenCalled();
    });

    it('supports a concrete app folder as its exact reopenable origin', async () => {
        const { files } = sourceFixture();
        const folder = Uri.file(path.join(base, 'WMS'));
        const catalog = await files.load({ kind: 'folder', uri: folder.toString(), label: 'WMS' }, new AbortController().signal);
        expect(catalog.origin.kind).toBe('folder');
        expect(catalog.roots[0]?.uri).toBe(folder.toString());
        expect(catalog.apps).toHaveLength(1);
    });

    it('requires explicit saving of an untitled workspace and rejects empty/virtual origins', () => {
        const { uris } = sourceFixture();
        const none = { candidate: false, active: null, diagnostic: null };
        workspace.workspaceFile = Uri.parse('untitled:Untitled-1');
        expect(() => currentOrigin(none, uris)).toThrow(/Save this workspace/);
        workspace.workspaceFile = undefined;
        expect(() => currentOrigin(none, uris)).toThrow(/Open a saved/);
        workspace.workspaceFile = Uri.parse('memfs:/virtual/source.code-workspace');
        expect(() => currentOrigin(none, uris)).toThrow(/filesystem host/);
    });

    it.each([
        { folders: [{ path: 'WMS', uri: 'file:///unexpected' }] },
        { folders: [{ path: 'WMS', uri: false }] },
        { folders: [{ path: null, uri: Uri.file(path.join(base, 'WMS')).toString() }] },
        { folders: [{ name: 'No path' }] },
        { folders: [{ path: '${env:ROOT}/WMS' }] },
        { folders: [{ path: 'C:drive-relative' }] },
        { folders: [{ path: 'Missing' }] },
        { folders: [{ path: 'WMS', name: '' }] },
        { folders: [{ path: 'WMS' }, { path: './WMS' }] },
        { folders: [false] }
    ])('rejects malformed, missing and duplicate listed roots', async ({ folders }) => {
        const { files } = sourceFixture();
        setFile(sourceUri, JSON.stringify({ folders }));
        await expect(files.load(origin, new AbortController().signal)).rejects.toThrow();
    });

    it('rejects malformed manifests instead of silently treating them as non-app roots', async () => {
        const { files } = sourceFixture();
        setFile(Uri.file(path.join(base, 'WMS', 'app.json')), '{"name":"broken"}');
        await expect(files.load(origin, new AbortController().signal)).rejects.toThrow(/canonical GUID/);
    });

    it('rejects stale/cancelled reads and does not write source resources', async () => {
        const { files } = sourceFixture();
        const operation = new AbortController();
        operation.abort();
        await expect(files.load(origin, operation.signal)).rejects.toThrow();
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it('retains the remote authority and resolves POSIX folder paths on the workspace host', async () => {
        const uris = new WorkspaceUris({ scheme: 'vscode-remote', authority: 'ssh-remote+fixture' });
        const uri = Uri.parse('vscode-remote://ssh-remote+fixture/home/repo/source.code-workspace');
        setFile(uri, '{"folders":[{"path":"WMS"}]}');
        setFile(Uri.parse('vscode-remote://ssh-remote+fixture/home/repo/WMS'), '', FileType.Directory);
        setFile(Uri.parse('vscode-remote://ssh-remote+fixture/home/repo/WMS/app.json'), manifestText());
        const files = new WorkspaceFiles(uris);
        const catalog = await files.load({ kind: 'workspace', uri: uri.toString(), label: 'Remote' }, new AbortController().signal);
        expect(catalog.roots[0]?.uri).toBe('vscode-remote://ssh-remote+fixture/home/repo/WMS');
        expect(catalog.roots[0]?.absolutePath).toBe('/home/repo/WMS');
    });

    it('resolves POSIX file URIs without depending on the client platform', async () => {
        setUriPlatform('linux');
        const source = Uri.parse('file:///home/repo/source.code-workspace');
        const identity = filesystemHost(source);
        expect(identity).toEqual({ scheme: 'file', authority: '' });
        const uris = new WorkspaceUris(identity);
        setFile(source, '{"folders":[{"path":"WMS"}]}');
        setFile(Uri.parse('file:///home/repo/WMS'), '', FileType.Directory);
        setFile(Uri.parse('file:///home/repo/WMS/app.json'), manifestText());
        const catalog = await new WorkspaceFiles(uris).load({ kind: 'workspace', uri: source.toString(), label: 'Remote' }, new AbortController().signal);
        expect(catalog.roots[0]?.uri).toBe('file:///home/repo/WMS');
        expect(catalog.roots[0]?.absolutePath).toBe('/home/repo/WMS');
    });

    it('rejects mixed remote/client authorities and untrusted metadata origin schemes', () => {
        const uris = new WorkspaceUris({ scheme: 'vscode-remote', authority: 'ssh-remote+fixture' });
        for (const uri of ['file:///C:/client/Apps', 'vscode-remote://ssh-remote+other/home/Apps', 'command:run']) {
            expect(() => { uris.validateOrigin({ kind: 'folder', uri, label: 'Untrusted' }); }).toThrow(/filesystem host/);
        }
    });

    it('rejects relative filesystem metadata and resolves remote Windows paths without a Windows client assumption', () => {
        const uris = new WorkspaceUris({ scheme: 'vscode-remote', authority: 'ssh-remote+windows' });
        expect(() => { uris.validate(new Uri('vscode-remote', 'ssh-remote+windows', 'relative/path')); }).toThrow(/absolute/);
        const source = { kind: 'workspace' as const, uri: 'vscode-remote://ssh-remote+windows/C%3A/repo/source.code-workspace', label: 'Windows source' };
        const app = uris.resolveFolder(source, { path: '..\\Apps\\WMS' });
        expect(app.path).toBe('/C:/Apps/WMS');
        expect(uris.pathValue(app)).toBe('C:\\Apps\\WMS');
        expect(uris.resolveFolder(source, { path: 'D:\\Apps\\WMS' }).path).toBe('/D:/Apps/WMS');
    });

    it('protects UNC source roots across authority and path casing without folding remote POSIX paths', () => {
        expect(containsUri(new Uri('file', 'SERVER', '/Share/Apps'), new Uri('file', 'server', '/share/apps/cache'))).toBe(true);
        expect(sameUri(new Uri('file', 'SERVER', '/Share/Apps'), new Uri('file', 'server', '/share/apps'))).toBe(true);
        expect(containsUri(new Uri('vscode-remote', 'ssh-remote+host', '/Apps'), new Uri('vscode-remote', 'ssh-remote+host', '/apps/cache'))).toBe(false);
    });
});
