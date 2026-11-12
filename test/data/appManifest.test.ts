import { describe, expect, expectTypeOf, it } from 'vitest';

import { compareVersions, readAppManifest } from '../../src/al/appManifest';
import { decodeUtf8, readJsoncObject } from '../../src/shared/jsonc';
import { appId, manifestText } from '../support/fixtures';
import type { AppDependency, AppManifest } from '../../src/shared/focusTypes';

describe('AL manifest validation', () => {
    it('projects schema models while preserving existing normalization without runtime freezing', () => {
        const app = readAppManifest(manifestText({
            id: appId(1).toUpperCase(),
            name: '  WMS  ',
            publisher: ' Publisher ',
            version: '01.2.3.4',
            unrelated: { preservedInSource: true },
            dependencies: [{ appId: appId(2), name: ' Base ', publisher: ' Publisher ', version: '1.0.0.0', ignored: true }]
        }), 'app.json');
        expect(app).toEqual({ id: appId(1), name: 'WMS', publisher: 'Publisher', version: '01.2.3.4', dependencies: [{ id: appId(2), name: 'Base', publisher: 'Publisher', version: '1.0.0.0' }] });
        expect(Object.isFrozen(app)).toBe(false);
        expect(Object.isFrozen(app.dependencies)).toBe(false);
        expectTypeOf<AppManifest['dependencies']>().toEqualTypeOf<readonly AppDependency[]>();
    });

    it('accepts JSONC comments, trailing commas, a BOM and uppercase IDs', () => {
        const text = `\uFEFF{\n// app identity\n"id":"${appId(15).toUpperCase()}","name":"WMS","publisher":"Publisher","version":"1.2.3.4","dependencies":[],}`;
        expect(readAppManifest(text, 'app.json').id).toBe(appId(15));
    });

    it('resolves legacy appId and matching modern/legacy IDs', () => {
        const dependency = { appId: appId(2), name: 'Base', publisher: 'Publisher', version: '1.0.0.0' };
        expect(readAppManifest(manifestText({ dependencies: [dependency] }), 'app.json').dependencies[0]?.id).toBe(appId(2));
        expect(readAppManifest(manifestText({ dependencies: [{ ...dependency, id: appId(2).toUpperCase() }] }), 'app.json').dependencies[0]?.id).toBe(appId(2));
    });

    it('rejects conflicting legacy IDs with dependency context', () => {
        const text = manifestText({ dependencies: [{ id: appId(2), appId: appId(3), name: 'Base', publisher: 'Publisher', version: '1.0.0.0' }] });
        expect(() => readAppManifest(text, 'WMS/app.json')).toThrow(/WMS\/app.json.dependencies\[0\].*different apps/);
    });

    it.each([
        ['id', 'not-a-guid'],
        ['id', null],
        ['name', ' '],
        ['publisher', ''],
        ['version', '1.2.3'],
        ['version', '1.2.3.4.5'],
        ['version', '-1.2.3.4'],
        ['version', '2147483648.0.0.0'],
        ['dependencies', {}],
        ['dependencies', null]
    ])('rejects malformed %s', (key, value) => {
        expect(() => readAppManifest(manifestText({ [key]: value }), 'app.json')).toThrow();
    });

    it.each([
        { name: 'Base', publisher: 'Publisher', version: '1.0.0.0' },
        { id: appId(2), publisher: 'Publisher', version: '1.0.0.0' },
        { id: appId(2), name: 'Base', publisher: 'Publisher', version: '1.0' },
        false
    ])('rejects invalid dependency objects', dependency => {
        expect(() => readAppManifest(manifestText({ dependencies: [dependency] }), 'app.json')).toThrow();
    });

    it('accepts older manifests without a dependencies property', () => {
        expect(readAppManifest(`{"id":"${appId(1)}","name":"WMS","publisher":"Publisher","version":"1.0.0.0"}`, 'app.json').dependencies).toEqual([]);
    });

    it('compares four-part versions numerically rather than lexically', () => {
        expect(compareVersions('1.10.0.0', '1.2.0.0')).toBe(1);
        expect(compareVersions('1.2.0.0', '1.2.0.1')).toBe(-1);
        expect(compareVersions('01.2.0.0', '1.2.0.0')).toBe(0);
    });

    it('reports syntax and root-shape errors rather than empty catalogues', () => {
        expect(() => readAppManifest('{"id":', 'broken/app.json')).toThrow(/broken\/app.json/);
        expect(() => readAppManifest('[]', 'app.json')).toThrow(/must contain an object/);
        expect(() => readJsoncObject('', 'workspace')).toThrow(/empty document/);
    });

    it('preserves BOM bytes in decoded input and rejects invalid UTF-8', () => {
        expect(decodeUtf8(new Uint8Array([239, 187, 191, 123, 125]), 'source')).toBe('\uFEFF{}');
        expect(() => decodeUtf8(new Uint8Array([255]), 'source')).toThrow(/valid UTF-8/);
    });
});
