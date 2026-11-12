import * as z from 'zod';

import { FocusError } from './focusTypes';

const VERSION_ERROR = 'expected four integer version components between 0 and 2147483647.';
const IDENTITY_ERROR = 'expected a nonempty string.';

export const GuidSchema = z.guid({ error: 'expected a canonical GUID.' }).transform(value => value.toLowerCase());
export const IdentitySchema = z.string({ error: IDENTITY_ERROR }).trim().min(1, { error: IDENTITY_ERROR });
export const VersionSchema = z.string({ error: VERSION_ERROR })
    .regex(/^\d+\.\d+\.\d+\.\d+$/, { error: VERSION_ERROR })
    .refine(value => value.split('.').every(part => Number(part) <= 2147483647), { error: VERSION_ERROR });

export function boundedText(maximum: number, message: string): z.ZodType<string> {
    return z.string({ error: message }).refine(value => value.length > 0 && value.length <= maximum && !value.includes('\0'), { error: message });
}

export function readSchema<T>(schema: z.ZodType<T>, value: unknown, label: string, code: string): T {
    const result = schema.safeParse(value);
    if (result.success) {
        return result.data;
    }
    const issue = result.error.issues[0];
    const path = issue?.path.map(part => typeof part === 'number' ? `[${part.toString()}]` : `.${String(part)}`).join('') ?? '';
    throw new FocusError(code, `${label}${path}: ${issue?.message ?? 'Invalid data.'}`);
}
