import type { FocusOptions } from './settings';
import type * as z from 'zod';
import type { AppDependencySchema, AppManifestSchema } from '../al/appManifest';
import type { FocusMetadataSchema } from '../workspace/cacheMetadata';

type DeepReadonly<T> = T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

export interface Diagnostic {
    readonly code: string;
    readonly message: string;
    readonly location?: string;
}

export interface WorkspaceOrigin {
    readonly kind: 'workspace' | 'folder';
    readonly uri: string;
    readonly label: string;
}

export interface WorkspaceRoot {
    readonly index: number;
    readonly uri: string;
    readonly manifestUri: string;
    readonly absolutePath: string;
    readonly folderName: string;
    readonly name: string;
    readonly entry: Readonly<Record<string, unknown>>;
    readonly manifestText: string | null;
}

export type AppDependency = DeepReadonly<z.output<typeof AppDependencySchema>>;
export type AppManifest = DeepReadonly<z.output<typeof AppManifestSchema>>;

export interface App {
    readonly root: WorkspaceRoot;
    readonly manifest: AppManifest;
    readonly isTest: boolean;
}

export interface WorkspaceCatalog {
    readonly origin: WorkspaceOrigin;
    readonly workspaceText: string;
    readonly roots: readonly WorkspaceRoot[];
    readonly apps: readonly App[];
    readonly byId: ReadonlyMap<string, App>;
}

export interface FocusSelection {
    readonly selectedIds: readonly string[];
    readonly selectedNames: readonly string[];
    readonly apps: readonly App[];
    readonly roots: readonly WorkspaceRoot[];
    readonly diagnostics: readonly Diagnostic[];
    readonly options: FocusOptions;
}

export type FocusMetadata = DeepReadonly<z.output<typeof FocusMetadataSchema>>;

export interface ActiveFocus {
    readonly workspaceUri: string;
    readonly metadata: FocusMetadata;
    readonly modified: boolean;
}

export interface CacheRecognition {
    readonly candidate: boolean;
    readonly active: ActiveFocus | null;
    readonly diagnostic: string | null;
}

export class FocusError extends Error {
    public constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'FocusError';
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
