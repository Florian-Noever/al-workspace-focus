import { describe, expect, it } from 'vitest';

import { createCatalog, resolveFocus } from '../../src/al/dependencyGraph';
import { isRecord } from '../../src/shared/focusTypes';
import { readJsoncObject } from '../../src/shared/jsonc';
import { createPathContext, rewriteString } from '../../src/workspace/pathRewriter';
import { transformWorkspace } from '../../src/workspace/workspaceTransform';
import { appId, catalogFixture, ORIGIN, rootFixture } from '../support/fixtures';

describe('context-aware path rewriting', () => {
    const roots = [rootFixture(0, 'WMS'), rootFixture(1, 'Removed')];
    const context = createPathContext(roots, roots.slice(0, 1));

    it.each([
        'C:\\repo\\file.json',
        'D:/repo/file.json',
        '\\\\server\\share\\file.json',
        '//server/share/file.json',
        '/home/user/file.json',
        'vscode-remote://ssh-remote+server/home/repo',
        'https://example.invalid/a',
        'file:///C:/repo/file.json',
        '${workspaceFolder}/.vscode/file.json',
        '${workspaceFolder:WMS}/src',
        '${env:HOME}/src',
        '${command:resolvePath}/src',
        '/c',
        '/k',
        '/^foo[0-9]+$/i',
        './src/**/*.al',
        '../{one,two}/*.json',
        'an arbitrary description',
        'bare-unknown-setting-value'
    ])('preserves non-workspace-relative or non-path strings: %s', value => {
        expect(rewriteString(value, ['settings', 'unknown'], context)).toEqual({ value, diagnostics: [] });
    });

    it.each(['al.packageCachePath', 'al.ruleSetPath', 'al.assemblyProbingPaths', 'al.codeAnalyzers'])('preserves app-relative %s', setting => {
        expect(rewriteString('./../.alpackages', ['settings', setting, 0], context).diagnostics).toEqual([]);
        expect(rewriteString('./ruleset.json', ['settings', setting], context).value).toBe('./ruleset.json');
    });

    it('anchors bare and dotted folder paths to the original directory, including Windows backslashes', () => {
        const windowsRoot = rootFixture(0, 'WMS', { absolutePath: 'C:\\repo\\apps\\WMS' });
        const windows = createPathContext([windowsRoot], [windowsRoot]);
        for (const value of ['apps\\WMS', '.\\apps\\WMS', '..\\repo\\apps\\WMS']) {
            expect(rewriteString(value, ['folders', 0, 'path'], windows).value).toBe('C:\\repo\\apps\\WMS');
        }
        expect(rewriteString('/srv/WMS', ['folders', 0, 'path'], context).value).toBe('/srv/WMS');
    });

    it('leaves ambiguous relative strings unchanged and reports the exact JSON location', () => {
        const result = rewriteString('../shared/config.json', ['tasks', 'tasks', 0, 'options', 'cwd'], context);
        expect(result.value).toBe('../shared/config.json');
        expect(result.diagnostics[0]?.location).toBe('$["tasks"]["tasks"][0]["options"]["cwd"]');
        expect(result.diagnostics[0]?.message).not.toContain('../shared/config.json');
    });

    it('warns on variables naming removed roots without evaluating variables', () => {
        const value = '${workspaceFolder:Removed}/src/${env:SECRET}';
        const result = rewriteString(value, ['launch', 'configurations', 0, 'program'], context);
        expect(result.value).toBe(value);
        expect(result.diagnostics[0]?.code).toBe('removed-workspace-variable');
    });

    it('warns when a removed root shares a custom name with a retained root instead of assuming the variable still means the same root', () => {
        const original = [rootFixture(0, 'Shared'), rootFixture(1, 'Shared', { id: null, folderName: '.resources' })];
        const result = rewriteString('${workspaceFolder:Shared}/file', ['settings', 'unknown'], createPathContext(original, original.slice(1)));
        expect(result.diagnostics[0]?.code).toBe('removed-workspace-variable');
    });
});

describe('surgical JSONC workspace transformation', () => {
    it.each([
        { selected: [0], trailing: false },
        { selected: [2], trailing: true },
        { selected: [4], trailing: false },
        { selected: [0, 2, 4], trailing: true },
        { selected: [1, 3], trailing: false }
    ])('prunes leading, adjacent, separated and trailing runs while retaining selected comments: %j', ({ selected, trailing }) => {
        const roots = Array.from({ length: 5 }, (_, index) => rootFixture(index, `App${index.toString()}`));
        const source = `{
    "folders": [
${roots.map((root, index) => `        ${JSON.stringify(root.entry)}${index < roots.length - 1 || trailing ? ',' : ''} // selected-comment-${index.toString()}`).join('\n')}
    ],
    "settings": {},
    "outside":{ "keep" : [1,2,3] }
}
`;
        const catalog = createCatalog(ORIGIN, source, roots);
        const selection = resolveFocus(catalog, selected.map(index => appId(index + 1)), { includeTests: false });
        const result = transformWorkspace(catalog, selection);
        expect(readJsoncObject(result.text, 'result').value.folders).toEqual(selected.map(index => ({ path: `/repo/App${index.toString()}`, name: `App${index.toString()}` })));
        for (const index of selected) {
            expect(result.text).toContain(`// selected-comment-${index.toString()}`);
        }
        expect(result.text).toContain('"outside":{ "keep" : [1,2,3] }');
        expect(catalog.workspaceText).toBe(source);
    });

    it('removes a final run from a compact workspace without corrupting its closing bracket', () => {
        const roots = [rootFixture(0, 'Keep'), rootFixture(1, 'Remove'), rootFixture(2, 'AlsoRemove')];
        const source = JSON.stringify({ folders: roots.map(root => root.entry) });
        const catalog = createCatalog(ORIGIN, source, roots);
        const result = transformWorkspace(catalog, resolveFocus(catalog, [appId(1)], { includeTests: false }));
        expect(readJsoncObject(result.text, 'result').value.folders).toEqual([{ path: '/repo/Keep', name: 'Keep' }]);
    });

    it('preserves a UTF-8 BOM while removing roots and inserting the captured setting', () => {
        const roots = [rootFixture(0, 'WMS'), rootFixture(1, 'Removed')];
        const catalog = catalogFixture(roots);
        const withBom = { ...catalog, workspaceText: `\uFEFF${catalog.workspaceText}` };
        const result = transformWorkspace(withBom, resolveFocus(withBom, [appId(1)], { includeTests: false }));
        expect(result.text.startsWith('\uFEFF')).toBe(true);
        expect(readJsoncObject(result.text, 'result').value.folders).toEqual([{ path: '/repo/WMS', name: 'WMS' }]);
    });

    it('preserves comments, custom folder names/attributes and unrelated configuration while producing physical LF', () => {
        const source = [
            '{',
            '    // workspace header',
            '    "folders": [',
            '        { "path": "./WMS", "name": "Warehouse", "custom": {"enabled":true} }, // selected root',
            '        { "path": "Removed", "name": "Removed" },',
            '        { "path": ".resources", "name": "Resources", "custom": 17 } // retained non-app',
            '    ],',
            '    // leave this setting block alone',
            '    "settings": {',
            '        "al.packageCachePath": "./../.alpackages",',
            '        "al.ruleSetPath": "./ruleset.json",',
            '        "files.eol": "\\r\\n",',
            '        "files.exclude": { "**/*.tmp": true },',
            '        "unknown": ["./ambiguous", {"nested": ["${workspaceFolder:Removed}/file"]}]',
            '    },',
            '    "extensions": {"recommendations":["ms-dynamics-smb.al"]},',
            '    "launch": {"configurations":[{"program":"${workspaceFolder:Warehouse}/main","args":["/c"]}]},',
            '    "tasks": {"tasks":[{"options":{"cwd":"../shared"},"command":"echo","args":["/k"]}]},',
            '    "unknownRoot": {"preserve": true}',
            '}',
            ''
        ].join('\r\n');
        const rootValues = readJsoncObject(source, 'fixture').value.folders;
        if (!Array.isArray(rootValues)) {
            throw new Error('Invalid fixture');
        }
        const entries: unknown[] = rootValues;
        function entryAt(index: number): Readonly<Record<string, unknown>> {
            const value = entries[index];
            if (!isRecord(value)) {
                throw new Error('Invalid fixture folder entry');
            }
            return value;
        }
        const roots = [
            rootFixture(0, 'Warehouse', { folderName: 'WMS', entry: entryAt(0) }),
            rootFixture(1, 'Removed', { entry: entryAt(1) }),
            rootFixture(2, 'Resources', { id: null, folderName: '.resources', entry: entryAt(2) })
        ];
        const catalog = createCatalog(ORIGIN, source, roots);
        const result = transformWorkspace(catalog, resolveFocus(catalog, [appId(1)], { includeTests: false }));
        const { value } = readJsoncObject(result.text, 'result');
        expect(result.text).not.toContain('\r');
        expect(result.text).toContain('// workspace header');
        expect(result.text).toContain('// leave this setting block alone');
        expect(result.text).toContain('// selected root');
        expect(result.text).toContain('// retained non-app');
        expect(value.folders).toEqual([
            { path: '/repo/WMS', name: 'Warehouse', custom: { enabled: true } },
            { path: '/repo/.resources', name: 'Resources', custom: 17 }
        ]);
        expect(result.text).toContain('"files.eol": "\\r\\n"');
        expect(result.text).toContain('"al.packageCachePath": "./../.alpackages"');
        expect(value.extensions).toEqual({ recommendations: ['ms-dynamics-smb.al'] });
        expect(value.unknownRoot).toEqual({ preserve: true });
        expect(result.diagnostics.map(diagnostic => diagnostic.location)).toContain('$["settings"]["unknown"][1]["nested"][0]');
        expect(result.diagnostics.map(diagnostic => diagnostic.location)).toContain('$["tasks"]["tasks"][0]["options"]["cwd"]');
        expect(catalog.workspaceText).toBe(source);
    });

    it('preserves remote URI authorities and unknown URI folder attributes', () => {
        const uri = 'vscode-remote://ssh-remote+host/home/repo/WMS';
        const root = rootFixture(0, 'WMS', { uri, absolutePath: '/home/repo/WMS', entry: { uri, name: 'Warehouse', extra: 42 } });
        const catalog = catalogFixture([root], {}, { kind: 'workspace', uri: 'vscode-remote://ssh-remote+host/home/repo/source.code-workspace', label: 'source.code-workspace' });
        const result = transformWorkspace(catalog, resolveFocus(catalog, [appId(1)], { includeTests: true }));
        expect(readJsoncObject(result.text, 'result').value.folders).toEqual([{ uri, name: 'Warehouse', extra: 42 }]);
    });

    it('captures the effective extension-owned test option only in the generated workspace', () => {
        const catalog = catalogFixture([rootFixture(0, 'WMS')], { settings: { 'alWorkspaceFocus.includeTests': false, other: true } });
        const result = transformWorkspace(catalog, resolveFocus(catalog, [appId(1)], { includeTests: true }));
        expect(readJsoncObject(result.text, 'result').value.settings).toEqual({ 'alWorkspaceFocus.includeTests': true, other: true });
        expect(readJsoncObject(catalog.workspaceText, 'source').value.settings).toEqual({ 'alWorkspaceFocus.includeTests': false, other: true });
    });
});
