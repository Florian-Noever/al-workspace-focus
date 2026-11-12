import type { App, Diagnostic } from '../shared/focusTypes';

export interface TestMatch {
    readonly app: App | null;
    readonly diagnostic: Diagnostic | null;
}

export function isTestApp(folderName: string, manifestName: string): boolean {
    return / Test$/i.test(folderName) || / Test$/i.test(manifestName);
}

function parentUri(uri: string): string {
    return uri.slice(0, uri.lastIndexOf('/'));
}

export function matchTestApp(production: App, apps: readonly App[]): TestMatch {
    const publisher = production.manifest.publisher.toLowerCase();
    const candidates = apps.filter(app => app.isTest && app.manifest.publisher.toLowerCase() === publisher);
    const siblingName = `${production.root.folderName} Test`.toLowerCase();
    const siblings = candidates.filter(app => app.root.folderName.toLowerCase() === siblingName && parentUri(app.root.uri) === parentUri(production.root.uri));
    const manifestName = `${production.manifest.name} Test`.toLowerCase();
    const matches = siblings.length > 0 ? siblings : candidates.filter(app => app.manifest.name.toLowerCase() === manifestName);
    if (matches.length === 1 && matches[0] !== undefined) {
        return { app: matches[0], diagnostic: null };
    }
    const ambiguous = matches.length > 1;
    return {
        app: null,
        diagnostic: {
            code: ambiguous ? 'ambiguous-test' : 'missing-test',
            message: ambiguous ? `${production.root.name}: multiple listed test apps match; select the intended test explicitly.` : `${production.root.name}: no matching test app is listed in the original workspace; select a test explicitly if it has another name.`
        }
    };
}
