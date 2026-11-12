import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createCatalog, resolveFocus } from '../../src/al/dependencyGraph';
import { digest } from '../support/digest';
import { isRecord } from '../../src/shared/focusTypes';
import { decodeUtf8, readJsoncObject } from '../../src/shared/jsonc';
import { transformWorkspace } from '../../src/workspace/workspaceTransform';

import type { WorkspaceOrigin, WorkspaceRoot } from '../../src/shared/focusTypes';

export async function checkRepresentative(file: string): Promise<void> {
    const workspaceFile = path.resolve(file);
    const bytes = await readFile(workspaceFile);
    const workspaceText = decodeUtf8(bytes, 'Representative workspace');
    const { value } = readJsoncObject(workspaceText, 'Representative workspace');
    const entries = value.folders;
    assert.ok(Array.isArray(entries), 'The representative workspace has no folder array.');
    const origin: WorkspaceOrigin = { kind: 'workspace', uri: pathToFileURL(workspaceFile).toString(), label: path.basename(workspaceFile) };
    const roots: WorkspaceRoot[] = [];
    const sourceDigests = new Map<string, string>([[workspaceFile, digest(bytes)]]);
    for (const [index, entry] of entries.entries()) {
        assert.ok(isRecord(entry), 'The representative workspace contains a malformed folder root.');
        const folderPath = typeof entry.path === 'string' ? path.resolve(path.dirname(workspaceFile), entry.path) : typeof entry.uri === 'string' ? fileURLToPath(entry.uri) : null;
        assert.ok(folderPath, 'A representative root has no local path/URI.');
        assert.ok((await stat(folderPath)).isDirectory(), 'A representative listed root is not readable as a directory.');
        const manifestFile = path.join(folderPath, 'app.json');
        let manifestText: string | null = null;
        try {
            const manifest = await readFile(manifestFile);
            manifestText = decodeUtf8(manifest, manifestFile);
            sourceDigests.set(manifestFile, digest(manifest));
        } catch (error) {
            if (!isRecord(error) || error.code !== 'ENOENT') {
                throw error;
            }
        }
        const folderName = path.basename(folderPath);
        roots.push({ index, uri: pathToFileURL(folderPath).toString(), manifestUri: pathToFileURL(manifestFile).toString(), absolutePath: folderPath, folderName, name: typeof entry.name === 'string' ? entry.name : folderName, entry, manifestText });
    }
    const catalog = createCatalog(origin, workspaceText, roots);
    const wms = catalog.apps.find(app => app.root.folderName.toLowerCase() === 'wms');
    assert.ok(wms, 'WMS must be a directly listed original app root.');
    const focused = resolveFocus(catalog, [wms.manifest.id], { includeTests: false });
    const tests = resolveFocus(catalog, [wms.manifest.id], { includeTests: true });
    assert.equal(catalog.apps.length, 283);
    assert.equal(catalog.roots.filter(root => root.manifestText === null).length, 3);
    assert.equal(focused.apps.length, 14);
    assert.equal(tests.apps.length, 25);
    assert.equal(focused.roots.length, 17);
    assert.equal(tests.roots.length, 28);
    const focusedText = transformWorkspace(catalog, focused);
    const testsText = transformWorkspace(catalog, tests);
    for (const [source, expected] of sourceDigests) {
        assert.equal(digest(await readFile(source)), expected, 'A representative source file changed during this read-only check.');
    }
    process.stdout.write(JSON.stringify({ listedApps: catalog.apps.length, nonAppRoots: 3, wmsApps: focused.apps.length, wmsWithTestsApps: tests.apps.length, wmsRoots: focused.roots.length, wmsWithTestsRoots: tests.roots.length, checkedSourceFiles: sourceDigests.size, sourceHashesUnchanged: true, pathWarnings: focusedText.diagnostics.length, pathWarningsWithTests: testsText.diagnostics.length }) + '\n');
}
