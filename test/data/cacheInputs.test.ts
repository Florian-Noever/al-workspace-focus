import { describe, expect, it } from 'vitest';

import { resolveFocus } from '../../src/al/dependencyGraph';
import { cacheInputs } from '../../src/workspace/cacheInputs';
import { parseMetadata } from '../../src/workspace/cacheMetadata';
import { CACHE_FORMAT_VERSION, EXTENSION_NAME, PATH_POLICY, TRANSFORM_VERSION } from '../../src/shared/settings';
import { appId, catalogFixture, rootFixture } from '../support/fixtures';

import type { FocusMetadata, WorkspaceCatalog } from '../../src/shared/focusTypes';

function key(catalog: WorkspaceCatalog, ids = [appId(1)], includeTests = false, host = 'host'): string {
    return cacheInputs(catalog, resolveFocus(catalog, ids, { includeTests }), host);
}

describe('deterministic cache inputs', () => {
    const catalog = catalogFixture([rootFixture(0, 'WMS'), rootFixture(1, 'Other'), rootFixture(2, '.resources', { id: null })]);

    it('normalizes selection order and duplicates while preserving original root order', () => {
        expect(key(catalog, [appId(2), appId(1), appId(2)])).toBe(key(catalog, [appId(1), appId(2)]));
        expect(key(catalog)).toBe(key(catalog));
    });

    it('invalidates for workspace bytes, even comments, and any listed manifest bytes', () => {
        expect(key({ ...catalog, workspaceText: `${catalog.workspaceText}// edit\n` })).not.toBe(key(catalog));
        const roots = catalog.roots.map(root => root.index === 1 ? { ...root, manifestText: `${root.manifestText ?? ''}\n` } : root);
        expect(key({ ...catalog, roots })).not.toBe(key(catalog));
    });

    it('invalidates for selections, test options, host identity, origin and no-manifest markers', () => {
        expect(key(catalog, [appId(2)])).not.toBe(key(catalog));
        expect(key(catalog, [appId(1)], true)).not.toBe(key(catalog));
        expect(key(catalog, [appId(1)], false, 'different-host')).not.toBe(key(catalog));
        expect(key({ ...catalog, origin: { ...catalog.origin, uri: 'file:///other/source.code-workspace' } })).not.toBe(key(catalog));
        const roots = catalog.roots.map(root => root.index === 2 ? { ...root, manifestText: '{}' } : root);
        expect(key({ ...catalog, roots })).not.toBe(key(catalog));
    });

    it('contains no AL source-file content and records versioned path/transform policy', () => {
        const inputs = key(catalog);
        expect(inputs).toContain(PATH_POLICY);
        expect(inputs).toContain('"transformVersion":1');
        expect(inputs).toContain('"kind":"no-manifest"');
        expect(inputs).not.toContain('.al"');
    });
});

describe('untrusted cache metadata guards', () => {
    const metadata: FocusMetadata = {
        owner: EXTENSION_NAME,
        formatVersion: CACHE_FORMAT_VERSION,
        transformVersion: TRANSFORM_VERSION,
        pathPolicy: PATH_POLICY,
        hostFingerprint: 'a'.repeat(64),
        sourceKey: 'b'.repeat(64),
        inputHash: 'c'.repeat(64),
        workspaceDigest: 'd'.repeat(64),
        origin: { kind: 'workspace', uri: 'file:///repo/source.code-workspace', label: 'Source' },
        selectedIds: [appId(1)],
        selectedNames: ['WMS'],
        options: { includeTests: false },
        roots: ['WMS', '.resources'],
        appCount: 1
    };

    it('round-trips the supported, fully guarded DTO', () => {
        expect(parseMetadata(JSON.stringify(metadata))).toEqual(metadata);
    });

    it('keeps cache IDs and digests canonical instead of normalizing untrusted metadata', () => {
        const upper = appId(15).toUpperCase();
        expect(() => parseMetadata(JSON.stringify({ ...metadata, selectedIds: [upper] }))).toThrow(/canonical, unique and sorted/);
        expect(() => parseMetadata(JSON.stringify({ ...metadata, workspaceDigest: 'A'.repeat(64) }))).toThrow(/invalid fingerprints or digests/);
        expect(() => parseMetadata(JSON.stringify({ ...metadata, selectedIds: [''] }))).toThrow(/invalid selections/);
        expect(() => parseMetadata(JSON.stringify({ ...metadata, selectedIds: [appId(1) + '\0'] }))).toThrow(/invalid selections/);
        try {
            parseMetadata(JSON.stringify({ ...metadata, selectedIds: ['bad'] }));
            throw new Error('Expected invalid cached GUID');
        } catch (error) {
            expect(error).toMatchObject({ code: 'invalid-manifest' });
        }
    });

    it('retains UTF-16 text bounds, NUL rejection and unknown-field projection', () => {
        const withLabel = (label: string) => JSON.stringify({ ...metadata, origin: { ...metadata.origin, label }, unknown: 17 });
        const astral = '\u{1F600}';
        expect(parseMetadata(withLabel(astral.repeat(1000))).origin.label).toBe(astral.repeat(1000));
        expect(() => parseMetadata(withLabel(astral.repeat(1001)))).toThrow(/original workspace/);
        expect(() => parseMetadata(withLabel('Source\0'))).toThrow(/original workspace/);
        expect(parseMetadata(JSON.stringify({ ...metadata, unknown: 17 }))).toEqual(metadata);
    });

    it.each([
        { owner: 'other-extension' },
        { formatVersion: 999 },
        { pathPolicy: 'blind-prefix' },
        { hostFingerprint: '../../escape' },
        { selectedIds: [appId(1), appId(1)] },
        { selectedIds: ['bad'] },
        { selectedIds: [] },
        { roots: [] },
        { appCount: 3 },
        { appCount: 0.5 },
        { options: { includeTests: 'true' } },
        { origin: { kind: 'command', uri: 'command:run', label: 'X' } }
    ])('rejects corrupt metadata', change => {
        expect(() => parseMetadata(JSON.stringify({ ...metadata, ...change }))).toThrow();
    });

    it('rejects JSON errors, null and success-shaped partial metadata', () => {
        expect(() => parseMetadata('{')).toThrow();
        expect(() => parseMetadata('null')).toThrow();
        expect(() => parseMetadata('{}')).toThrow();
    });
});
