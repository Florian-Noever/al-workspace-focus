import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Script } from 'node:vm';

import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

import { isRecord } from '../../src/shared/focusTypes';
import { readJsoncObject } from '../../src/shared/jsonc';

const repository = process.cwd();
const execute = promisify(execFile);

async function text(file: string): Promise<string> {
    return readFile(path.join(repository, file), 'utf8');
}

async function filesBelow(directory: string): Promise<readonly string[]> {
    const files: string[] = [];
    for (const entry of await readdir(path.join(repository, directory), { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await filesBelow(file));
        } else if (entry.isFile()) {
            files.push(file);
        }
    }
    return files;
}

async function manifest(): Promise<Readonly<Record<string, unknown>>> {
    const value: unknown = JSON.parse(await text('package.json'));
    if (!isRecord(value)) {
        throw new Error('The extension manifest is not an object.');
    }
    return value;
}

describe('repository and shipped-bundle contracts', () => {
    beforeAll(async () => {
        await mkdir(path.join(repository, 'out'), { recursive: true });
        await writeFile(path.join(repository, 'out', 'extension.js.map'), '{"version":3,"sources":["stale-watch-map"]}\n');
        await execute(process.execPath, [path.join(repository, 'esbuild.mjs')], { cwd: repository, timeout: 30000 });
    }, 40000);

    it('loads the actual browser bundle without Node modules, process or Buffer', async () => {
        const code = await text(path.join('out', 'extension.js'));
        const module: { exports: unknown } = { exports: {} };
        const loaded = new Set<string>();
        new Script(code, { filename: 'extension.js' }).runInNewContext({
            module,
            exports: module.exports,
            require: (specifier: string): unknown => {
                loaded.add(specifier);
                if (specifier === 'vscode') {
                    return {};
                }
                throw new Error(`The browser bundle has an unexpected runtime import: ${specifier}`);
            },
            crypto: webcrypto,
            TextDecoder,
            TextEncoder,
            URL,
            AbortController
        }, { timeout: 5000 });
        expect(isRecord(module.exports) && typeof module.exports.activate === 'function').toBe(true);
        expect(loaded.has('vscode')).toBe(true);
        expect([...loaded].some(specifier => specifier.includes('impl/format') || specifier === 'jsonc-parser')).toBe(false);
    });

    it('ships only the browser bundle, supplied PNG artwork and public documentation/license', async () => {
        const value = await manifest();
        expect(value.main).toBeUndefined();
        expect(value.files).toEqual(['LICENSE', 'README.md', 'CHANGELOG.md', 'assets/icon-x512.png', 'assets/icon-x48.png', 'out/extension.js', 'out/THIRD-PARTY-NOTICES.txt']);
        expect(value.icon).toBe('assets/icon-x512.png');
        expect(value.extensionKind).toBeUndefined();
        expect(value.browser).toBe('./out/extension.js');
        expect(value.publisher).toBe('Florian-Noever');
        expect(value.license).toBe('MIT');
        expect(value.author).toBeUndefined();
        if (!isRecord(value.repository) || typeof value.repository.url !== 'string') {
            throw new Error('Missing repository metadata');
        }
        expect(value.bugs).toEqual({ url: `${value.repository.url}/issues` });
        expect(value.homepage).toBe(value.repository.url);
        expect(value.qna).toBe(`${value.repository.url}/issues`);
        expect(value.markdown).toBe('github');
        const icon = await readFile(path.join(repository, 'assets', 'icon-x512.png'));
        expect([...icon.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(icon.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
        expect(icon.readUInt32BE(20)).toBe(icon.readUInt32BE(16));
        const header = await readFile(path.join(repository, 'assets', 'icon-x48.png'));
        expect([...header.subarray(0, 8)]).toEqual([...icon.subarray(0, 8)]);
    });

    it('materially minifies normal output without inline or stale external source maps', async () => {
        const code = await text(path.join('out', 'extension.js'));
        const readable = await build({
            entryPoints: [path.join(repository, 'src', 'extension', 'extension.ts')],
            bundle: true,
            platform: 'browser',
            mainFields: ['browser', 'module', 'main'],
            format: 'cjs',
            target: 'es2022',
            external: ['vscode'],
            write: false,
            minify: false,
            sourcemap: false,
            logLevel: 'silent'
        });
        const output = readable.outputFiles[0];
        if (output === undefined) {
            throw new Error('Missing readable comparison bundle');
        }
        expect(new TextEncoder().encode(code).length).toBeLessThan(output.contents.length * 0.75);
        expect(code).not.toMatch(/sourceMappingURL\s*=/);
        expect(await readdir(path.join(repository, 'out'))).not.toContain('extension.js.map');
    });

    it('generates complete installed production licenses rather than manual or development-only notices', async () => {
        const value = await manifest();
        if (!isRecord(value.dependencies)) {
            throw new Error('Missing runtime dependencies');
        }
        const notices = await text(path.join('out', 'THIRD-PARTY-NOTICES.txt'));
        const expected: string[] = [];
        for (const name of Object.keys(value.dependencies)) {
            const directory = path.join('node_modules', name);
            const packageJson: unknown = JSON.parse(await text(path.join(directory, 'package.json')));
            if (!isRecord(packageJson) || typeof packageJson.version !== 'string') {
                throw new Error(`Missing installed package identity: ${name}`);
            }
            expected.push(`${name}@${packageJson.version}`);
            const files = await readdir(path.join(repository, directory));
            const license = files.find(file => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(file));
            if (license === undefined) {
                throw new Error(`Missing original license for ${name}`);
            }
            expect(notices).toContain((await text(path.join(directory, license))).replace(/\r\n?/g, '\n').trim());
        }
        expect([...notices.matchAll(/^ - (.+)$/gm)].map(match => match[1]).sort()).toEqual(expected.sort());
        expect(notices).not.toContain('\r');
        expect(await readdir(repository)).not.toContain('THIRD-PARTY-NOTICES.txt');
    });

    it('fails normal builds when licenses cannot be resolved instead of leaving stale notices to package', async () => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'alwf-license-failure-'));
        const notices = path.join(fixture, 'out', 'THIRD-PARTY-NOTICES.txt');
        try {
            await mkdir(path.dirname(notices));
            await writeFile(notices, 'stale notices\n');
            const script = `await import(${JSON.stringify(pathToFileURL(path.join(repository, 'esbuild.mjs')).toString())});`;
            const failure: unknown = await execute(process.execPath, ['--input-type=module', '--eval', script], { cwd: fixture, timeout: 30000 }).catch((error: unknown) => error);
            if (!isRecord(failure) || typeof failure.stderr !== 'string') {
                throw new Error('Expected a license-generation build failure with stderr');
            }
            expect(failure.code).toBe(1);
            expect(failure.stderr).toContain('generate-license-file');
            await expect(readFile(notices, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('keeps vscode types aligned with the minimum engine and does not install AL/Vue/native runtime dependencies', async () => {
        const value = await manifest();
        const engines = value.engines;
        const development = value.devDependencies;
        expect(isRecord(engines) && isRecord(development)).toBe(true);
        if (!isRecord(engines) || !isRecord(development)) {
            throw new Error('Missing engine/dependency metadata');
        }
        const engine = engines.vscode;
        const types = development['@types/vscode'];
        expect(typeof engine === 'string' && typeof types === 'string').toBe(true);
        if (typeof engine !== 'string' || typeof types !== 'string') {
            throw new Error('Missing VS Code version pins');
        }
        expect((/\d+\.\d+/.exec(engine))?.[0]).toBe((/\d+\.\d+/.exec(types))?.[0]);
        expect(value.dependencies).toEqual({ 'jsonc-parser': '^3.3.1', 'p-map': '^7.1.1', zod: '^4.6.7' });
        expect(development.mocha).toBeUndefined();
        expect(development['@types/mocha']).toBeUndefined();
        const runner: unknown = JSON.parse(await text(path.join('node_modules', 'npm-run-all2', 'package.json')));
        if (!isRecord(runner) || !isRecord(runner.engines)) {
            throw new Error('Missing script-runner requirements');
        }
        expect(engines.node).toBe(runner.engines.node);
        if (typeof engines.npm !== 'string' || typeof runner.engines.npm !== 'string') {
            throw new Error('Missing npm requirements');
        }
        expect(engines.npm.replace(/\s+/g, '')).toBe(runner.engines.npm.replace(/\s+/g, ''));
        expect(value.extensionDependencies).toBeUndefined();
        expect(value.allowScripts).toEqual({ esbuild: true, '@vscode/vsce-sign': false, keytar: false });
    });

    it('keeps domain modules free of VS Code, filesystem, process and crypto imports', async () => {
        for (const directory of ['src/al', 'src/workspace', 'src/shared']) {
            for (const file of await filesBelow(directory)) {
                const source = await text(file);
                expect(source, file).not.toMatch(/(?:from|import)\s*['"](?:vscode|node:|fs['"/]|path['"/]|os['"/]|crypto['"/])/);
                expect(source, file).not.toMatch(/\bprocess\./);
            }
        }
    });

    it('does not mutate original workspace folders, trust broad temp paths or infer shutdown state', async () => {
        const production = (await Promise.all((await filesBelow('src')).map(file => text(file)))).join('\n');
        expect(production).not.toMatch(/updateWorkspaceFolders|security\.workspace\.trust\.enabled|disable-workspace-trust|sessionId|process\.pid/);
        expect(production).toContain('forceReuseWindow: true, noRecentEntry: true');
        expect(production).not.toContain('al-actionimage-viewer');
        expect(production).not.toContain('xliff-viewer');
    });

    it('has exactly the intended commands, app.json context menus and default-off test setting', async () => {
        const value = await manifest();
        const contributes = value.contributes;
        if (!isRecord(contributes)) {
            throw new Error('Missing contributions');
        }
        const commands = contributes.commands;
        if (!Array.isArray(commands)) {
            throw new Error('Missing commands');
        }
        const ids = commands.map((command: unknown) => {
            if (!isRecord(command) || typeof command.command !== 'string') {
                throw new Error('Invalid command contribution');
            }
            return command.command;
        });
        expect(ids).toEqual(['alWorkspaceFocus.focus', 'alWorkspaceFocus.unfocus', 'alWorkspaceFocus.refresh']);
        expect(isRecord(commands[0]) && commands[0].enablement).toBe('alWorkspaceFocus.ready');
        expect(isRecord(commands[1]) && commands[1].enablement).toBe('alWorkspaceFocus.active');
        expect(isRecord(commands[2]) && commands[2].enablement).toBe('alWorkspaceFocus.active && alWorkspaceFocus.ready');
        const configuration = contributes.configuration;
        expect(isRecord(configuration)).toBe(true);
        if (!isRecord(configuration) || !isRecord(configuration.properties)) {
            throw new Error('Missing configuration schema');
        }
        const option = configuration.properties['alWorkspaceFocus.includeTests'];
        expect(isRecord(option) && option.default === false).toBe(true);
        expect(configuration.properties['alWorkspaceFocus.showStartupNotification']).toMatchObject({ type: 'boolean', default: true, scope: 'window' });
        const menus = contributes.menus;
        expect(isRecord(menus)).toBe(true);
        if (!isRecord(menus)) {
            throw new Error('Missing context menus');
        }
        expect(menus['explorer/context']).toEqual([{ command: ids[0], when: 'resourceFilename == app.json && alWorkspaceFocus.ready', group: 'alWorkspaceFocus@1' }]);
        expect(menus['editor/context']).toEqual(menus['explorer/context']);
    });

    it('uses verified Node-only reusable workflow inputs and keeps engine/type upgrades coupled', async () => {
        const ci = await text(path.join('.github', 'workflows', 'ci.yml'));
        const release = await text(path.join('.github', 'workflows', 'publish.yml'));
        const dependabot = await text(path.join('.github', 'dependabot.yml'));
        for (const workflow of [ci, release]) {
            expect(workflow).toContain('check-command: npm run ci:check');
            expect(workflow).toContain('test-command: npm run test:integration');
            expect(workflow).toContain('required-files: |');
            for (const file of ['out/extension.js', 'out/THIRD-PARTY-NOTICES.txt', 'assets/icon-x512.png', 'assets/icon-x48.png', 'readme.md', 'LICENSE.txt']) {
                expect(workflow).toContain(`        ${file}`);
            }
            expect(workflow).toContain('pack-dependencies: false');
            expect(workflow).not.toMatch(/out\/web|VITE_|MARKETPLACE_PAT|secrets:\s*inherit/);
        }
        expect(release).toContain('vs-marketplace: true');
        expect(release).toContain('open-vsx: true');
        expect(release).toContain('OPEN_VSX_TOKEN: ${{ secrets.OPEN_VSX_TOKEN }}');
        expect(dependabot).toContain("dependency-name: '@types/vscode'");
    });

    it('connects F5 to real watch scripts and independently acknowledged background tasks', async () => {
        const value = await manifest();
        const scripts = value.scripts;
        const tasks = readJsoncObject(await text(path.join('.vscode', 'tasks.json')), 'tasks').value.tasks;
        const launch = readJsoncObject(await text(path.join('.vscode', 'launch.json')), 'launch').value.configurations;
        if (!isRecord(scripts) || !Array.isArray(tasks) || !Array.isArray(launch)) {
            throw new Error('Missing development scripts or tasks');
        }
        const byLabel = new Map(tasks.map((task: unknown) => {
            if (!isRecord(task) || typeof task.label !== 'string') {
                throw new Error('Invalid development task');
            }
            return [task.label, task] as const;
        }));
        const watch = byLabel.get('watch');
        expect(watch?.group).toEqual({ kind: 'build', isDefault: true });
        if (!Array.isArray(watch?.dependsOn)) {
            throw new Error('Watch task has no dependencies');
        }
        const dependencies: unknown[] = watch.dependsOn;
        for (const label of dependencies) {
            if (typeof label !== 'string') {
                throw new Error('Invalid watch dependency');
            }
            const task = byLabel.get(label);
            if (task === undefined || typeof task.script !== 'string') {
                throw new Error(`Missing watch task ${label}`);
            }
            expect(typeof scripts[task.script]).toBe('string');
            expect(task.isBackground).toBe(true);
            expect(task.problemMatcher).toBeDefined();
        }
        expect(byLabel.get('npm: watch:browser-types')?.problemMatcher).toEqual({ base: '$tsc-watch', owner: 'typescript-browser' });
        expect(launch[0]).toMatchObject({ debugWebWorkerHost: true, preLaunchTask: '${defaultBuildTask}' });
    });

    it('keeps repository text LF', async () => {
        const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', '.gitattributes', '.editorconfig', 'eslint.config.mjs', 'vitest.config.ts', 'esbuild.mjs', 'assets/icon.svg', ...await filesBelow('src'), ...await filesBelow('.github')];
        for (const file of files) {
            expect(await text(file), file).not.toContain('\r');
        }
    });
});
