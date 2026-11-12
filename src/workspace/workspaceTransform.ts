import { applyEdits, createScanner, findNodeAtLocation, modify } from 'jsonc-parser';

import { FocusError } from '../shared/focusTypes';
import { readJsoncObject } from '../shared/jsonc';
import { INCLUDE_TESTS_CONFIGURATION } from '../shared/settings';
import { createPathContext, rewriteString } from './pathRewriter';

import type { Edit, Node } from 'jsonc-parser';
import type { PathContext } from './pathRewriter';
import type { Diagnostic, FocusSelection, WorkspaceCatalog } from '../shared/focusTypes';

export interface TransformedWorkspace {
    readonly text: string;
    readonly diagnostics: readonly Diagnostic[];
}

function collectStringEdits(node: Node, path: ReadonlyArray<string | number>, context: PathContext, edits: Edit[], diagnostics: Diagnostic[]): void {
    if (node.type === 'string' && typeof node.value === 'string') {
        const result = rewriteString(node.value, path, context);
        diagnostics.push(...result.diagnostics);
        if (result.value !== node.value) {
            edits.push({ offset: node.offset, length: node.length, content: JSON.stringify(result.value) });
        }
        return;
    }
    if (node.type === 'object') {
        for (const property of node.children ?? []) {
            const key = property.children?.[0];
            const value = property.children?.[1];
            if (key !== undefined && typeof key.value === 'string' && value !== undefined) {
                collectStringEdits(value, [...path, key.value], context, edits, diagnostics);
            }
        }
    } else if (node.type === 'array') {
        for (const [index, child] of (node.children ?? []).entries()) {
            if (path.length === 1 && path[0] === 'folders' && !context.retainedIndexes.has(index)) {
                continue;
            }
            collectStringEdits(child, [...path, index], context, edits, diagnostics);
        }
    }
}

export function transformWorkspace(catalog: WorkspaceCatalog, selection: FocusSelection): TransformedWorkspace {
    const { tree } = readJsoncObject(catalog.workspaceText, 'Original workspace');
    const folders = findNodeAtLocation(tree, ['folders']);
    if (folders?.type !== 'array') {
        throw new FocusError('invalid-workspace', 'The original workspace must have a folders array.');
    }
    const diagnostics: Diagnostic[] = [];
    const edits: Edit[] = [];
    const context = createPathContext(catalog.roots, selection.roots);
    collectStringEdits(tree, [], context, edits, diagnostics);
    const retained = context.retainedIndexes;
    const children = folders.children ?? [];
    // Delete omitted runs against the original offsets instead of reparsing the workspace per app.
    for (let index = 0; index < children.length;) {
        if (retained.has(index)) {
            index++;
            continue;
        }
        const first = children[index];
        const previous = children[index - 1];
        while (index < children.length && !retained.has(index)) {
            index++;
        }
        const next = children[index];
        const last = children[index - 1];
        if (first === undefined || last === undefined) {
            throw new FocusError('invalid-workspace', 'The original workspace has an invalid folder edit range.');
        }
        if (next !== undefined) {
            edits.push({ offset: first.offset, length: next.offset - first.offset, content: '' });
        } else if (previous !== undefined) {
            const scanner = createScanner(catalog.workspaceText, true);
            scanner.setPosition(previous.offset + previous.length);
            scanner.scan();
            if (catalog.workspaceText.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()) !== ',') {
                throw new FocusError('invalid-workspace', 'The original folder separator could not be located.');
            }
            edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: '' });
            edits.push({ offset: first.offset, length: last.offset + last.length - first.offset, content: '' });
        } else {
            edits.push({ offset: folders.offset + 1, length: folders.length - 2, content: '' });
        }
    }
    let text = applyEdits(catalog.workspaceText, edits);
    text = applyEdits(text, modify(text, ['settings', INCLUDE_TESTS_CONFIGURATION], selection.options.includeTests, {
        formattingOptions: { insertSpaces: true, tabSize: 4, eol: '\n' }
    }));
    text = text.replace(/\r\n?/g, '\n');
    readJsoncObject(text, 'Generated focus workspace');
    return { text, diagnostics };
}
