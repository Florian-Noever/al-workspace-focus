import { getNodeValue, parseTree, printParseErrorCode } from 'jsonc-parser';

import { FocusError, isRecord } from './focusTypes';

import type { Node, ParseError } from 'jsonc-parser';

export interface JsoncDocument {
    readonly tree: Node;
    readonly value: Readonly<Record<string, unknown>>;
}

export function readJsoncObject(text: string, label: string): JsoncDocument {
    const errors: ParseError[] = [];
    const input = text.startsWith('\uFEFF') ? ` ${text.slice(1)}` : text;
    if (input.trim().length === 0) {
        throw new FocusError('invalid-jsonc', `${label}: empty document.`);
    }
    const tree = parseTree(input, errors, { allowTrailingComma: true });
    if (errors.length > 0 || tree === undefined) {
        const first = errors[0];
        const detail = first === undefined ? 'empty document' : `${printParseErrorCode(first.error)} at offset ${first.offset.toString()}`;
        throw new FocusError('invalid-jsonc', `${label}: ${detail}.`);
    }
    const value: unknown = getNodeValue(tree);
    if (!isRecord(value)) {
        throw new FocusError('invalid-jsonc', `${label}: the document must contain an object.`);
    }
    return { tree, value };
}

export function jsonLocation(path: ReadonlyArray<string | number>): string {
    return '$' + path.map(segment => typeof segment === 'number' ? `[${segment.toString()}]` : `[${JSON.stringify(segment)}]`).join('');
}

export function decodeUtf8(bytes: Uint8Array, label: string): string {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
        throw new FocusError('invalid-encoding', `${label}: expected valid UTF-8 (${error instanceof Error ? error.message : 'decoding failed'}).`);
    }
}
