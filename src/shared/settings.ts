export const EXTENSION_NAME = 'al-workspace-focus';
export const CONFIGURATION_SECTION = 'alWorkspaceFocus';
export const INCLUDE_TESTS_SETTING = 'includeTests';
export const INCLUDE_TESTS_CONFIGURATION = `${CONFIGURATION_SECTION}.${INCLUDE_TESTS_SETTING}`;
export const SHOW_STARTUP_NOTIFICATION_SETTING = 'showStartupNotification';
export const FOCUS_READY_CONTEXT = `${CONFIGURATION_SECTION}.ready`;
export const CACHE_FORMAT_VERSION = 2;
export const BROWSER_CACHE_DIRECTORY = '.focussed';
export const TRANSFORM_VERSION = 1;
export const PATH_POLICY = 'context-aware-v1';

export interface FocusOptions {
    readonly includeTests: boolean;
}
