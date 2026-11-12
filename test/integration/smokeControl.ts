import { isRecord } from '../../src/shared/focusTypes';
import { isDigest } from '../../src/workspace/cacheMetadata';

export type SmokePhase = 'focus' | 'focused' | 'reloaded' | 'restarted' | 'unfocused';
export type SmokeStatus = 'running' | 'awaiting-trust' | 'awaiting-restart' | 'passed' | 'failed';

export interface SourceDigest {
    readonly uri: string;
    readonly digest: string;
}

export interface SmokeControl {
    readonly owner: 'al-workspace-focus-smoke';
    readonly token: string;
    readonly fixtureUri: string;
    readonly originKind: 'workspace' | 'folder';
    readonly originUri: string;
    readonly focusAppUri: string;
    readonly expectedAppCount: number;
    readonly expectedRootCount: number;
    readonly sourceDigests: readonly SourceDigest[];
    readonly phase: SmokePhase;
    readonly status: SmokeStatus;
    readonly cacheUri: string | null;
    readonly workspaceMtime: number | null;
    readonly metadataMtime: number | null;
    readonly hostVersion: string | null;
    readonly remoteName: string | null;
    readonly message: string | null;
    readonly journeys: readonly string[];
}

function isText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 32768;
}

function isNullableText(value: unknown): value is string | null {
    return value === null || isText(value);
}

function isNullableTime(value: unknown): value is number | null {
    return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isPhase(value: unknown): value is SmokePhase {
    return value === 'focus' || value === 'focused' || value === 'reloaded' || value === 'restarted' || value === 'unfocused';
}

function isStatus(value: unknown): value is SmokeStatus {
    return value === 'running' || value === 'awaiting-trust' || value === 'awaiting-restart' || value === 'passed' || value === 'failed';
}

export function parseControl(text: string): SmokeControl {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.owner !== 'al-workspace-focus-smoke' || typeof value.token !== 'string' || !/^[a-f0-9]{32}$/.test(value.token)) {
        throw new Error('The smoke driver refuses an unowned control file.');
    }
    const fixtureUri = value.fixtureUri;
    const originUri = value.originUri;
    const focusAppUri = value.focusAppUri;
    const originKind = value.originKind;
    const phase = value.phase;
    const status = value.status;
    const expectedAppCount = value.expectedAppCount;
    const expectedRootCount = value.expectedRootCount;
    const sourceDigests = value.sourceDigests;
    const cacheUri = value.cacheUri;
    const workspaceMtime = value.workspaceMtime;
    const metadataMtime = value.metadataMtime;
    const hostVersion = value.hostVersion;
    const remoteName = value.remoteName;
    const message = value.message;
    const journeys = value.journeys;
    if (!isText(fixtureUri) || !isText(originUri) || !isText(focusAppUri) || (originKind !== 'workspace' && originKind !== 'folder') || !isPhase(phase) || !isStatus(status)) {
        throw new Error('The smoke control has invalid origins, phase or status.');
    }
    if (typeof expectedAppCount !== 'number' || !Number.isSafeInteger(expectedAppCount) || expectedAppCount < 1 || expectedAppCount > 100 || typeof expectedRootCount !== 'number' || !Number.isSafeInteger(expectedRootCount) || expectedRootCount < expectedAppCount || expectedRootCount > 100) {
        throw new Error('The smoke control has invalid expected root/app counts.');
    }
    if (!Array.isArray(sourceDigests) || sourceDigests.length === 0 || sourceDigests.length > 100 || !Array.isArray(journeys) || !journeys.every((entry: unknown): entry is string => typeof entry === 'string')) {
        throw new Error('The smoke control has invalid source digests or journey records.');
    }
    const sources = sourceDigests.map((entry: unknown) => {
        if (!isRecord(entry) || !isText(entry.uri) || !isDigest(entry.digest)) {
            throw new Error('The smoke control contains an invalid source digest.');
        }
        return { uri: entry.uri, digest: entry.digest };
    });
    if (!isNullableText(cacheUri) || !isNullableTime(workspaceMtime) || !isNullableTime(metadataMtime) || !isNullableText(hostVersion) || !isNullableText(remoteName) || !isNullableText(message)) {
        throw new Error('The smoke control has invalid recorded cache/host values.');
    }
    return {
        owner: 'al-workspace-focus-smoke',
        token: value.token,
        fixtureUri,
        originKind,
        originUri,
        focusAppUri,
        expectedAppCount,
        expectedRootCount,
        sourceDigests: sources,
        phase,
        status,
        cacheUri,
        workspaceMtime,
        metadataMtime,
        hostVersion,
        remoteName,
        message,
        journeys
    };
}
