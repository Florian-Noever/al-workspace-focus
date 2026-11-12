import path from 'node:path';

import { vi } from 'vitest';

let uriPlatform: NodeJS.Platform = process.platform;

export function setUriPlatform(platform: NodeJS.Platform): void {
    uriPlatform = platform;
}

export class Uri {
    public readonly scheme: string;
    public readonly authority: string;
    public readonly path: string;
    public readonly query: string;
    public readonly fragment: string;

    public constructor(scheme: string, authority: string, uriPath: string, query = '', fragment = '') {
        this.scheme = scheme;
        this.authority = authority;
        this.path = uriPath;
        this.query = query;
        this.fragment = fragment;
    }

    public static parse(value: string): Uri {
        const parsed = new URL(value);
        return new Uri(parsed.protocol.slice(0, -1), parsed.host, decodeURIComponent(parsed.pathname), parsed.search.slice(1), parsed.hash.slice(1));
    }

    public static file(value: string): Uri {
        let uriPath = value.replace(/\\/g, '/');
        if (uriPath.startsWith('//')) {
            const separator = uriPath.indexOf('/', 2);
            return new Uri('file', uriPath.slice(2, separator), uriPath.slice(separator));
        }
        if (/^[a-z]:/i.test(uriPath)) {
            uriPath = `/${uriPath}`;
        }
        return new Uri('file', '', uriPath);
    }

    public static joinPath(uri: Uri, ...parts: string[]): Uri {
        return uri.with({ path: path.posix.join(uri.path, ...parts) });
    }

    public get fsPath(): string {
        if (this.scheme === 'vscode-remote') {
            return this.path;
        }
        let file = /^\/[a-z]:/i.test(this.path) ? this.path.slice(1) : this.path;
        if (this.authority.length > 0) {
            file = `//${this.authority}${file}`;
        }
        return uriPlatform === 'win32' ? file.replace(/\//g, '\\') : file;
    }

    public with(change: { readonly scheme?: string; readonly authority?: string; readonly path?: string; readonly query?: string; readonly fragment?: string }): Uri {
        return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment);
    }

    public toString(): string {
        const uriPath = this.path.split('/').map(segment => encodeURIComponent(segment)).join('/');
        const prefix = this.scheme === 'file' || this.scheme === 'vscode-remote' ? `${this.scheme}://${this.authority}` : `${this.scheme}:`;
        return `${prefix}${uriPath}${this.query.length > 0 ? `?${this.query}` : ''}${this.fragment.length > 0 ? `#${this.fragment}` : ''}`;
    }

    public toJSON(): Readonly<Record<string, unknown>> {
        return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
    }
}

export class ThemeColor {
    public readonly id: string;

    public constructor(id: string) {
        this.id = id;
    }
}

export class FileSystemError extends Error {
    public readonly code: string;

    public constructor(code: string) {
        super(code);
        this.code = code;
    }

    public static FileNotFound(): FileSystemError {
        return new FileSystemError('FileNotFound');
    }
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
export const ProgressLocation = { Notification: 15 };
export const StatusBarAlignment = { Left: 1, Right: 2 };

interface MemoryFile {
    readonly bytes: Uint8Array;
    readonly type: number;
}

interface MockDocument {
    readonly uri: Uri;
    readonly isDirty: boolean;
}

interface MockFolder {
    readonly name: string;
    readonly uri: Uri;
    readonly index: number;
}

const memory = new Map<string, MemoryFile>();
const configuration = new Map<string, unknown>();
export const contextKeys = new Map<string, unknown>();
const cancellationListeners = new Set<() => void>();
const trustListeners = new Set<() => void>();
const folderListeners = new Set<() => void>();
let cancelled = false;

function subscribe(listeners: Set<() => void>, listener: () => void): { dispose(): void } {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
}

export function grantWorkspaceTrust(): void {
    workspace.isTrusted = true;
    for (const listener of trustListeners) {
        listener();
    }
}

export function changeWorkspaceFolders(folders: MockFolder[] | undefined): void {
    workspace.workspaceFolders = folders;
    for (const listener of folderListeners) {
        listener();
    }
}

export function setFile(uri: Uri, text: string, type = FileType.File): void {
    memory.set(uri.toString(), { bytes: new TextEncoder().encode(text), type });
}

export function memoryFiles(): ReadonlyMap<string, MemoryFile> {
    return memory;
}

export function setSetting(key: string, value: unknown): void {
    configuration.set(key, value);
}

export function cancelProgress(): void {
    cancelled = true;
    for (const listener of cancellationListeners) {
        listener();
    }
}

export function listenerCount(): number {
    return cancellationListeners.size;
}

export const token = {
    get isCancellationRequested(): boolean {
        return cancelled;
    },
    onCancellationRequested: (listener: () => void) => {
        cancellationListeners.add(listener);
        return { dispose: () => { cancellationListeners.delete(listener); } };
    }
};

function readMemoryFile(uri: Uri): Promise<Uint8Array> {
    const file = memory.get(uri.toString());
    return file === undefined ? Promise.reject(FileSystemError.FileNotFound()) : Promise.resolve(file.bytes);
}

function readMemoryStat(uri: Uri): Promise<{ readonly type: number; readonly ctime: number; readonly mtime: number; readonly size: number }> {
    const file = memory.get(uri.toString());
    return file === undefined ? Promise.reject(FileSystemError.FileNotFound()) : Promise.resolve({ type: file.type, ctime: 0, mtime: 0, size: file.bytes.length });
}

function readMemoryDirectory(uri: Uri): Promise<ReadonlyArray<readonly [string, number]>> {
    if (!memory.has(uri.toString())) {
        return Promise.reject(FileSystemError.FileNotFound());
    }
    const prefix = `${uri.toString().replace(/\/+$/, '')}/`;
    return Promise.resolve([...memory].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).map(([key, file]) => [decodeURIComponent(key.slice(prefix.length)), file.type] as const));
}

function createMemoryDirectory(uri: Uri): Promise<void> {
    let current = uri;
    while (!memory.has(current.toString())) {
        setFile(current, '', FileType.Directory);
        const parent = Uri.joinPath(current, '..');
        if (parent.toString() === current.toString()) {
            break;
        }
        current = parent;
    }
    return Promise.resolve();
}

function writeMemoryFile(uri: Uri, content: Uint8Array): Promise<void> {
    memory.set(uri.toString(), { bytes: content.slice(), type: FileType.File });
    return Promise.resolve();
}

function deleteMemoryFile(uri: Uri, _options?: unknown): Promise<void> {
    const key = uri.toString();
    if (!memory.has(key)) {
        return Promise.reject(FileSystemError.FileNotFound());
    }
    if ([...memory.keys()].some(entry => entry.startsWith(`${key}/`))) {
        return Promise.reject(new Error('Directory is not empty'));
    }
    memory.delete(key);
    return Promise.resolve();
}

function renameMemoryFile(from: Uri, to: Uri, _options?: unknown): Promise<void> {
    const entry = memory.get(from.toString());
    if (entry === undefined) {
        return Promise.reject(FileSystemError.FileNotFound());
    }
    if (memory.has(to.toString())) {
        return Promise.reject(new FileSystemError('FileExists'));
    }
    memory.set(to.toString(), entry);
    memory.delete(from.toString());
    return Promise.resolve();
}

export const workspace = {
    workspaceFile: undefined as Uri | undefined,
    workspaceFolders: undefined as MockFolder[] | undefined,
    textDocuments: [] as MockDocument[],
    isTrusted: true,
    onDidGrantWorkspaceTrust: (listener: () => void) => subscribe(trustListeners, listener),
    onDidChangeWorkspaceFolders: (listener: () => void) => subscribe(folderListeners, listener),
    fs: {
        readFile: vi.fn(readMemoryFile),
        stat: vi.fn(readMemoryStat),
        readDirectory: vi.fn(readMemoryDirectory),
        createDirectory: vi.fn(createMemoryDirectory),
        isWritableFileSystem: vi.fn((_scheme: string): boolean | undefined => true),
        writeFile: vi.fn(writeMemoryFile),
        delete: vi.fn(deleteMemoryFile),
        rename: vi.fn(renameMemoryFile)
    },
    getConfiguration: (section: string) => ({
        get: (key: string, fallback: unknown): unknown => configuration.get(`${section}.${key}`) ?? fallback
    })
};

export const outputChannel = {
    error: vi.fn<() => void>(),
    warn: vi.fn<() => void>(),
    info: vi.fn<() => void>(),
    debug: vi.fn<() => void>(),
    show: vi.fn<() => void>(),
    dispose: vi.fn<() => void>()
};

export const statusBar = {
    name: undefined as string | undefined,
    command: undefined as string | undefined,
    text: '',
    tooltip: undefined as string | undefined,
    backgroundColor: undefined as ThemeColor | undefined,
    show: vi.fn<() => void>(),
    hide: vi.fn<() => void>(),
    dispose: vi.fn<() => void>()
};

export const window = {
    createOutputChannel: vi.fn(() => outputChannel),
    createStatusBarItem: vi.fn(() => statusBar),
    showInformationMessage: vi.fn((_message: string): Promise<string | undefined> => Promise.resolve(undefined)),
    showErrorMessage: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
    showWarningMessage: vi.fn((): Promise<string | undefined> => Promise.resolve('Continue Focus')),
    showOpenDialog: vi.fn((_options: unknown): Promise<readonly Uri[] | undefined> => Promise.resolve(undefined)),
    showQuickPick: vi.fn((_items: readonly unknown[]): Promise<readonly unknown[] | undefined> => Promise.resolve(undefined)),
    withProgress: vi.fn(async (_options: unknown, work: (progress: { report(value: unknown): void }, cancellation: typeof token) => Promise<unknown>): Promise<unknown> => work({ report: vi.fn<(value: unknown) => void>() }, token))
};

function executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    if (command === 'setContext' && typeof args[0] === 'string') {
        contextKeys.set(args[0], args[1]);
    }
    return Promise.resolve(undefined);
}

export const commands = {
    registerCommand: vi.fn((_command: string, _callback: (...args: unknown[]) => unknown) => ({ dispose: vi.fn<() => void>() })),
    executeCommand: vi.fn(executeCommand)
};

export function resetVscode(): void {
    uriPlatform = process.platform;
    memory.clear();
    configuration.clear();
    contextKeys.clear();
    cancelled = false;
    cancellationListeners.clear();
    trustListeners.clear();
    folderListeners.clear();
    workspace.workspaceFile = undefined;
    workspace.workspaceFolders = undefined;
    workspace.textDocuments = [];
    workspace.isTrusted = true;
    workspace.fs.readFile.mockReset().mockImplementation(readMemoryFile);
    workspace.fs.stat.mockReset().mockImplementation(readMemoryStat);
    workspace.fs.readDirectory.mockReset().mockImplementation(readMemoryDirectory);
    workspace.fs.createDirectory.mockReset().mockImplementation(createMemoryDirectory);
    workspace.fs.isWritableFileSystem.mockReset().mockReturnValue(true);
    workspace.fs.writeFile.mockReset().mockImplementation(writeMemoryFile);
    workspace.fs.delete.mockReset().mockImplementation(deleteMemoryFile);
    workspace.fs.rename.mockReset().mockImplementation(renameMemoryFile);
    for (const mock of Object.values(outputChannel)) {
        mock.mockClear();
    }
    statusBar.name = undefined;
    statusBar.command = undefined;
    statusBar.text = '';
    statusBar.tooltip = undefined;
    statusBar.backgroundColor = undefined;
    statusBar.show.mockClear();
    statusBar.hide.mockClear();
    statusBar.dispose.mockClear();
    window.createOutputChannel.mockClear();
    window.createStatusBarItem.mockClear();
    window.showInformationMessage.mockReset().mockResolvedValue(undefined);
    window.showErrorMessage.mockReset().mockResolvedValue(undefined);
    window.showWarningMessage.mockReset().mockResolvedValue('Continue Focus');
    window.showOpenDialog.mockReset().mockResolvedValue(undefined);
    window.showQuickPick.mockReset().mockResolvedValue(undefined);
    commands.registerCommand.mockClear();
    commands.executeCommand.mockReset().mockImplementation(executeCommand);
}
