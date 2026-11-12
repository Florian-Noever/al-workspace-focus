import * as z from 'zod';

import { readJsoncObject } from '../shared/jsonc';
import { GuidSchema, IdentitySchema, VersionSchema, readSchema } from '../shared/validation';

import type { AppManifest } from '../shared/focusTypes';

export const AppDependencySchema = z.looseObject({
    id: GuidSchema.optional(),
    appId: GuidSchema.optional()
}, { error: 'expected a dependency object.' }).transform((value, context) => {
    const id = value.id ?? value.appId;
    if (id === undefined) {
        context.addIssue({ code: 'custom', message: 'a dependency needs id or legacy appId.' });
        return z.NEVER;
    }
    if (value.id !== undefined && value.appId !== undefined && value.id !== value.appId) {
        context.addIssue({ code: 'custom', message: 'id and legacy appId identify different apps.' });
        return z.NEVER;
    }
    return { ...value, id };
}).pipe(z.object({
    id: GuidSchema,
    name: IdentitySchema,
    publisher: IdentitySchema,
    version: VersionSchema
}));

export const AppManifestSchema = z.looseObject({
    dependencies: z.array(z.unknown(), { error: 'expected an array.' }).optional().default([])
}).pipe(z.object({
    id: GuidSchema,
    name: IdentitySchema,
    publisher: IdentitySchema,
    version: VersionSchema,
    dependencies: z.array(AppDependencySchema)
}));

export function readGuid(value: unknown, label: string): string {
    return readSchema(GuidSchema, value, label, 'invalid-manifest');
}

export function readVersion(value: unknown, label: string): string {
    return readSchema(VersionSchema, value, label, 'invalid-manifest');
}

export function compareVersions(left: string, right: string): number {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (let index = 0; index < 4; index++) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) {
            return Math.sign(difference);
        }
    }
    return 0;
}

export function readAppManifest(text: string, label: string): AppManifest {
    return readSchema(AppManifestSchema, readJsoncObject(text, label).value, label, 'invalid-manifest');
}
