import * as z from 'zod';

import { FocusError } from '../shared/focusTypes';
import { boundedText } from '../shared/validation';
import { CACHE_FORMAT_VERSION, EXTENSION_NAME, PATH_POLICY, TRANSFORM_VERSION } from '../shared/settings';

import type { FocusMetadata } from '../shared/focusTypes';

const MARKER_ERROR = 'The cache ownership marker or supported format/path-policy version is missing.';
const ORIGIN_ERROR = 'Focus metadata has no valid original workspace/folder identity.';
const SELECTION_ERROR = 'Focus metadata has invalid selections, roots or test options.';
const DIGEST_ERROR = 'Focus metadata has invalid fingerprints or digests.';
const COUNT_ERROR = 'Focus metadata has inconsistent app/selection counts.';
const GUID_ERROR = 'Cached selected app ID: expected a canonical GUID.';
const IDS_ERROR = 'Cached app IDs must be canonical, unique and sorted.';
const DigestSchema = z.string({ error: DIGEST_ERROR }).regex(/^[a-f0-9]{64}$/, { error: DIGEST_ERROR });
const CacheIdSchema = z.guid({ error: GUID_ERROR })
    .refine(value => value.length > 0 && value.length <= 2000 && !value.includes('\0'), { error: SELECTION_ERROR })
    .refine(value => value === value.toLowerCase(), { error: IDS_ERROR });
const TextArraySchema = z.array(boundedText(2000, SELECTION_ERROR), { error: SELECTION_ERROR }).min(1, { error: SELECTION_ERROR }).max(10000, { error: SELECTION_ERROR });

export const FocusMetadataSchema = z.object({
    owner: z.literal(EXTENSION_NAME, { error: MARKER_ERROR }),
    formatVersion: z.literal(CACHE_FORMAT_VERSION, { error: MARKER_ERROR }),
    transformVersion: z.literal(TRANSFORM_VERSION, { error: MARKER_ERROR }),
    pathPolicy: z.literal(PATH_POLICY, { error: MARKER_ERROR }),
    hostFingerprint: DigestSchema,
    sourceKey: DigestSchema,
    inputHash: DigestSchema,
    workspaceDigest: DigestSchema,
    origin: z.object({
        kind: z.enum(['workspace', 'folder'], { error: ORIGIN_ERROR }),
        uri: boundedText(32768, ORIGIN_ERROR),
        label: boundedText(2000, ORIGIN_ERROR)
    }, { error: ORIGIN_ERROR }),
    selectedIds: z.array(CacheIdSchema, { error: SELECTION_ERROR }).min(1, { error: SELECTION_ERROR }).max(10000, { error: SELECTION_ERROR }),
    selectedNames: TextArraySchema,
    options: z.object({ includeTests: z.boolean({ error: SELECTION_ERROR }) }, { error: SELECTION_ERROR }),
    roots: TextArraySchema,
    appCount: z.number({ error: COUNT_ERROR }).refine(Number.isSafeInteger, { error: COUNT_ERROR })
}, { error: MARKER_ERROR }).superRefine((value, context) => {
    if (value.appCount < value.selectedIds.length || value.appCount > value.roots.length || value.selectedNames.length !== value.selectedIds.length) {
        context.addIssue({ code: 'custom', message: COUNT_ERROR });
    }
    const sorted = [...value.selectedIds].sort();
    if (new Set(value.selectedIds).size !== value.selectedIds.length || value.selectedIds.some((id, index) => id !== sorted[index])) {
        context.addIssue({ code: 'custom', message: IDS_ERROR });
    }
});

export function isDigest(value: unknown): value is string {
    return DigestSchema.safeParse(value).success;
}

export function parseMetadata(text: string): FocusMetadata {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new FocusError('invalid-cache', 'Focus metadata is not valid JSON.');
    }
    const result = FocusMetadataSchema.safeParse(value);
    if (!result.success) {
        const messages = result.error.issues.map(issue => issue.code === 'invalid_type' && issue.path[0] === 'selectedIds' ? SELECTION_ERROR : issue.message);
        const message = [MARKER_ERROR, ORIGIN_ERROR, SELECTION_ERROR, DIGEST_ERROR, COUNT_ERROR, GUID_ERROR, IDS_ERROR].find(candidate => messages.includes(candidate));
        throw new FocusError(message === GUID_ERROR ? 'invalid-manifest' : 'invalid-cache', message ?? MARKER_ERROR);
    }
    return result.data;
}
