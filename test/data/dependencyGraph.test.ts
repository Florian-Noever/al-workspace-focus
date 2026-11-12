import { describe, expect, it } from 'vitest';

import { createCatalog, resolveFocus } from '../../src/al/dependencyGraph';
import { matchTestApp } from '../../src/al/testAppMatcher';
import { appId, catalogFixture, dependency, ORIGIN, rootFixture } from '../support/fixtures';

describe('listed-root dependency closure', () => {
    it('unions transitive dependencies and retains every non-app root in original order', () => {
        const roots = [
            rootFixture(0, 'Base'),
            rootFixture(1, 'WMS', { dependencies: [dependency(appId(1), 'Base')] }),
            rootFixture(2, 'Installer', { dependencies: [dependency(appId(2), 'WMS')] }),
            rootFixture(3, 'Unrelated'),
            rootFixture(4, '.resources', { id: null, entry: { path: '.resources', name: 'Shared', custom: true } }),
            rootFixture(5, '.alpackages', { id: null }),
            rootFixture(6, 'AI-Tools', { id: null })
        ];
        const selection = resolveFocus(catalogFixture(roots), [appId(3), appId(2), appId(3)], { includeTests: false });
        expect(selection.apps.map(app => app.root.name)).toEqual(['Base', 'WMS', 'Installer']);
        expect(selection.roots.map(root => root.name)).toEqual(['Base', 'WMS', 'Installer', '.resources', '.alpackages', 'AI-Tools']);
        expect(selection.selectedIds).toEqual([appId(2), appId(3)]);
        expect(selection.roots[3]?.entry).toEqual(roots[4]?.entry);
    });

    it('includes required and explicitly selected tests even when automatic tests are off', () => {
        const catalog = catalogFixture([
            rootFixture(0, 'WMS', { dependencies: [dependency(appId(2), 'Required Test')] }),
            rootFixture(1, 'Required Test'),
            rootFixture(2, 'Other Test'),
            rootFixture(3, 'Unrelated')
        ]);
        expect(resolveFocus(catalog, [appId(1), appId(3)], { includeTests: false }).apps.map(app => app.root.name)).toEqual(['WMS', 'Required Test', 'Other Test']);
    });

    it('adds automatic tests only for explicitly selected production apps, not prerequisites', () => {
        const catalog = catalogFixture([
            rootFixture(0, 'Base'),
            rootFixture(1, 'Base Test'),
            rootFixture(2, 'WMS', { dependencies: [dependency(appId(1), 'Base')] }),
            rootFixture(3, 'WMS Test', { dependencies: [dependency(appId(1), 'Base')] })
        ]);
        expect(resolveFocus(catalog, [appId(3)], { includeTests: true }).apps.map(app => app.root.name)).toEqual(['Base', 'WMS', 'WMS Test']);
        expect(resolveFocus(catalog, [appId(3)], { includeTests: false }).apps.map(app => app.root.name)).toEqual(['Base', 'WMS']);
    });

    it('does not pair another test with a selected test app', () => {
        const catalog = catalogFixture([rootFixture(0, 'WMS Test')]);
        expect(resolveFocus(catalog, [appId(1)], { includeTests: true }).diagnostics).toEqual([]);
    });

    it('warns about external references with requester, ID and version without fabricating roots', () => {
        const catalog = catalogFixture([rootFixture(0, 'WMS', { dependencies: [dependency(appId(99), 'External', '9.0.0.0')] })]);
        const focus = resolveFocus(catalog, [appId(1)], { includeTests: false });
        expect(focus.apps).toHaveLength(1);
        expect(focus.diagnostics[0]?.message).toContain(`WMS requests External (Publisher), ID ${appId(99)}, version 9.0.0.0`);
    });

    it('warns for identity and version differences but uses the local GUID', () => {
        const catalog = catalogFixture([
            rootFixture(0, 'Base', { version: '1.0.0.0' }),
            rootFixture(1, 'WMS', { dependencies: [dependency(appId(1), 'Different name', '2.0.0.0', 'Different publisher')] })
        ]);
        const focus = resolveFocus(catalog, [appId(2)], { includeTests: false });
        expect(focus.apps).toHaveLength(2);
        expect(focus.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['dependency-identity', 'dependency-version']);
        expect(focus.diagnostics[1]?.message).toContain('below the required minimum');
    });

    it('rejects duplicate app IDs, including duplicate IDs differing only in case', () => {
        expect(() => catalogFixture([rootFixture(0, 'WMS', { id: appId(15) }), rootFixture(1, 'Other', { id: appId(15).toUpperCase() })])).toThrow(/Duplicate app ID.*WMS and Other/);
    });

    it('rejects cycles anywhere in the original catalogue, even outside a proposed focus', () => {
        const roots = [
            rootFixture(0, 'WMS'),
            rootFixture(1, 'Cycle A', { dependencies: [dependency(appId(3), 'Cycle B')] }),
            rootFixture(2, 'Cycle B', { dependencies: [dependency(appId(2), 'Cycle A')] })
        ];
        expect(() => createCatalog(ORIGIN, '{}', roots)).toThrow(/Cycle A -> Cycle B -> Cycle A/);
    });

    it('rejects self cycles, unknown selections and empty selections', () => {
        expect(() => catalogFixture([rootFixture(0, 'Self', { dependencies: [dependency(appId(1), 'Self')] })])).toThrow(/cycle/);
        const catalog = catalogFixture([rootFixture(0, 'WMS')]);
        expect(() => resolveFocus(catalog, [], { includeTests: false })).toThrow(/at least one/);
        expect(() => resolveFocus(catalog, [appId(99)], { includeTests: false })).toThrow(/no longer listed/);
    });
});

describe('test pairing', () => {
    it('prefers a same-publisher physical sibling, including abbreviated names and installer tests without a parent dependency', () => {
        const catalog = catalogFixture([
            rootFixture(0, 'Installer', { folderName: 'INST', manifestName: 'Long Installer App' }),
            rootFixture(1, 'Installer checks', { folderName: 'INST Test', manifestName: 'Abbreviated Installer Checks' }),
            rootFixture(2, 'Fallback', { folderName: 'Elsewhere', manifestName: 'Long Installer App Test' })
        ]);
        const focus = resolveFocus(catalog, [appId(1)], { includeTests: true });
        expect(focus.apps.map(app => app.root.name)).toEqual(['Installer', 'Installer checks']);
    });

    it('falls back to a unique manifest-name/publisher match across original listed roots', () => {
        const catalog = catalogFixture([
            rootFixture(0, 'WMS', { manifestName: 'Warehouse Management' }),
            rootFixture(1, 'Tests', { folderName: 'Different', manifestName: 'Warehouse Management Test', uri: 'file:///repo/elsewhere/Different' })
        ]);
        expect(resolveFocus(catalog, [appId(1)], { includeTests: true }).apps).toHaveLength(2);
    });

    it('warns rather than guessing on absent or ambiguous matches', () => {
        const absent = catalogFixture([rootFixture(0, 'WMS'), rootFixture(1, 'WMS Test', { publisher: 'Other' })]);
        expect(resolveFocus(absent, [appId(1)], { includeTests: true }).diagnostics[0]?.code).toBe('missing-test');
        const ambiguous = catalogFixture([
            rootFixture(0, 'WMS'),
            rootFixture(1, 'One Test', { manifestName: 'WMS Test' }),
            rootFixture(2, 'Two Test', { manifestName: 'WMS Test' })
        ]);
        const production = ambiguous.apps[0];
        expect(production).toBeDefined();
        if (production === undefined) {
            throw new Error('Missing fixture app');
        }
        expect(matchTestApp(production, ambiguous.apps).app).toBeNull();
        expect(resolveFocus(ambiguous, [appId(1)], { includeTests: true }).diagnostics[0]?.code).toBe('ambiguous-test');
    });
});
