import * as vscode from 'vscode';

import { FocusError, isRecord } from '../shared/focusTypes';
import { decodeUtf8 } from '../shared/jsonc';

export interface FilesystemHost {
    readonly scheme: 'file' | 'vscode-remote';
    readonly authority: string;
}

type StageFile = 'focus.code-workspace' | 'focus.json' | 'stage.json';

const STAGE_FILES: readonly StageFile[] = ['focus.code-workspace', 'focus.json', 'stage.json'];

export function errorCode(error: unknown): string | null {
    return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

export async function orMissing<T>(operation: PromiseLike<T>): Promise<T | null> {
    try {
        return await operation;
    } catch (error) {
        if (errorCode(error) === 'FileNotFound') {
            return null;
        }
        throw error;
    }
}

function hex(bytes: Uint8Array): string {
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function digest(value: string | Uint8Array): Promise<string> {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export function randomToken(): string {
    return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export function isToken(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

export function normalizedUri(uri: vscode.Uri): vscode.Uri {
    const normalized = vscode.Uri.joinPath(uri, '.');
    return /^\/[a-z]:$/i.test(normalized.path) ? normalized.with({ path: `${normalized.path}/` }) : normalized;
}

export function uriKey(uri: vscode.Uri): string {
    uri = normalizedUri(uri);
    const windows = uri.scheme === 'file' && (/^\/[a-z]:\//i.test(uri.path) || uri.authority.length > 0);
    return windows ? uri.toString().toLowerCase() : uri.toString();
}

export function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
    return uriKey(left) === uriKey(right);
}

export function containsUri(parent: vscode.Uri, child: vscode.Uri): boolean {
    const sameAuthority = parent.scheme === 'file' ? parent.authority.toLowerCase() === child.authority.toLowerCase() : parent.authority === child.authority;
    if (parent.scheme !== child.scheme || !sameAuthority || parent.query.length > 0 || parent.fragment.length > 0 || child.query.length > 0 || child.fragment.length > 0) {
        return false;
    }
    parent = normalizedUri(parent);
    child = normalizedUri(child);
    const windows = parent.scheme === 'file' && (/^\/[a-z]:\//i.test(parent.path) || parent.authority.length > 0);
    const base = (windows ? parent.path.toLowerCase() : parent.path).replace(/\/+$/, '');
    const candidate = windows ? child.path.toLowerCase() : child.path;
    return candidate === base || candidate.startsWith(`${base}/`);
}

export function relativeParts(root: vscode.Uri, uri: vscode.Uri): readonly string[] | null {
    if (!containsUri(root, uri) || sameUri(root, uri)) {
        return null;
    }
    return uri.path.slice(root.path.replace(/\/+$/, '').length + 1).split('/');
}

export async function isDirectory(uri: vscode.Uri): Promise<boolean> {
    const info = await orMissing(vscode.workspace.fs.stat(uri));
    if (info === null) {
        return false;
    }
    if ((info.type & vscode.FileType.Directory) === 0 || (info.type & vscode.FileType.SymbolicLink) !== 0) {
        throw new FocusError('unsafe-cache', 'A cache directory is a link or is not a regular directory. Choose a private filesystem folder.');
    }
    return true;
}

export async function ensureDirectory(root: vscode.Uri, directory: vscode.Uri): Promise<boolean> {
    directory = normalizedUri(directory);
    const parts = relativeParts(root, directory);
    if (parts === null && !sameUri(directory, root)) {
        throw new FocusError('unsafe-cache', 'Refusing to create a directory outside the selected cache root.');
    }
    const directories = [root];
    let parent = root;
    for (const part of parts ?? []) {
        parent = vscode.Uri.joinPath(parent, part);
        directories.push(parent);
    }
    const present = await Promise.all(directories.map(folder => isDirectory(folder)));
    if (present.includes(false)) {
        await vscode.workspace.fs.createDirectory(directory);
        if ((await Promise.all(directories.map(folder => isDirectory(folder)))).includes(false)) {
            throw new FocusError('cache-directory', 'The cache directory was not created.');
        }
    }
    return present.at(-1) === false;
}

export async function readOptional(uri: vscode.Uri, maximumBytes: number, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    const info = await orMissing(vscode.workspace.fs.stat(uri));
    if (info === null) {
        return null;
    }
    if ((info.type & vscode.FileType.File) === 0 || (info.type & vscode.FileType.SymbolicLink) !== 0 || info.size > maximumBytes) {
        throw new FocusError('unsafe-cache', 'A cache file is a link, is not a regular file, or exceeds its size limit.');
    }
    const bytes = await orMissing(vscode.workspace.fs.readFile(uri));
    if (bytes === null) {
        return null;
    }
    signal?.throwIfAborted();
    if (bytes.length > maximumBytes) {
        throw new FocusError('invalid-cache', 'A cache file grew beyond its size limit.');
    }
    return decodeUtf8(bytes, 'Cache file');
}

export async function variants(directory: vscode.Uri): Promise<readonly string[]> {
    const entries = await vscode.workspace.fs.readDirectory(directory);
    if (entries.length > 1000) {
        throw new FocusError('cache-limit', 'This selection has more than 1000 cache entries. Move unused entries out of the selected cache folder and retry.');
    }
    return entries.filter(([name, type]) => isToken(name) && type === vscode.FileType.Directory).map(([name]) => name).sort();
}

export class Stage {
    private constructor(public readonly directory: vscode.Uri, private readonly marker: string) {}

    public static async create(parent: vscode.Uri): Promise<Stage> {
        const token = randomToken();
        const stage = new Stage(vscode.Uri.joinPath(parent, token), JSON.stringify({ owner: 'al-workspace-focus-browser', token }));
        if (await isDirectory(stage.directory)) {
            throw new FocusError('cache-contention', 'The random cache entry already exists. It has been preserved; retry Focus.');
        }
        await vscode.workspace.fs.createDirectory(stage.directory);
        await stage.write('stage.json', stage.marker);
        return stage;
    }

    public async write(name: StageFile, text: string, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.directory, name), new TextEncoder().encode(text));
    }

    public async remove(): Promise<void> {
        if (await readOptional(vscode.Uri.joinPath(this.directory, 'stage.json'), 1024) !== this.marker) {
            throw new FocusError('unsafe-cleanup', 'The incomplete cache ownership marker changed; its files have been preserved.');
        }
        for (const name of STAGE_FILES) {
            await orMissing(vscode.workspace.fs.delete(vscode.Uri.joinPath(this.directory, name), { recursive: false }));
        }
        await vscode.workspace.fs.delete(this.directory, { recursive: false });
    }
}
