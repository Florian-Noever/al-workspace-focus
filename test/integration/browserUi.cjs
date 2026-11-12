const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function waitFor(label, probe, milliseconds = 30000) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
        const result = await probe();
        if (result) {
            return result;
        }
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}.`);
}

async function click(client, point, button = 'left') {
    for (const type of ['mousePressed', 'mouseReleased']) {
        await client.call('Input.dispatchMouseEvent', { type, ...point, button, clickCount: 1 });
    }
}

async function connectTo(launched, profile) {
    const deadline = Date.now() + 60000;
    let port;
    while (!port && Date.now() < deadline) {
        const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(launched.output());
        if (match) {
            port = Number(match[1]);
        } else {
            try {
                port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }
        }
        if (!port) {
            await delay(100);
        }
    }
    if (!port) {
        throw new Error('The owned UI debugger did not start');
    }
    let page;
    while (!page && Date.now() < deadline) {
        try {
            const pages = await (await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)).json();
            page = pages.find(item => item.type === 'page' && item.url.startsWith('vscode-file:'));
        } catch (error) {
            if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) {
                throw error;
            }
        }
        if (!page) {
            await delay(100);
        }
    }
    if (!page) {
        throw new Error('The owned workbench page did not start');
    }
    const socket = new globalThis.WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
        const result = JSON.parse(event.data), request = pending.get(result.id);
        if (!request) {
            return;
        }
        pending.delete(result.id);
        clearTimeout(request.timer);
        result.error ? request.reject(new Error(JSON.stringify(result.error))) : request.resolve(result.result);
    });
    socket.addEventListener('close', () => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('Owned UI debugger disconnected'));
        }
        pending.clear();
    });
    return {
        call(method, params = {}) {
            return new Promise((resolve, reject) => {
                const id = ++sequence;
                const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Owned UI debugger timed out: ${method}`)); }, 15000);
                pending.set(id, { resolve, reject, timer });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
        close() {
            socket.close();
        }
    };
}

async function evaluate(client, expression) {
    const value = await client.call('Runtime.evaluate', { expression, returnByValue: true });
    if (value.exceptionDetails) {
        throw new Error(JSON.stringify(value.exceptionDetails));
    }
    return value.result.value;
}

async function grantFixtureTrust(client) {
    const point = await evaluate(client, `(() => {
        const modal=document.querySelector('.monaco-dialog-box');
        if(modal?.querySelector('.monaco-custom-checkbox.checked'))throw new Error('Refusing broad checked trust in the owned fixture dialog');
        const button=modal
            ? [...modal.querySelectorAll('.monaco-button')].find(item=>['Trust Workspace & Continue','Yes, I trust the authors'].includes(item.textContent.trim()))
            : [...document.querySelectorAll('.workspace-trust-editor .monaco-button')].find(item=>item.textContent.trim()==='Trust');
        if(!button)return null;
        const r=button.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;
    })()`);
    if (!point) {
        return false;
    }
    await click(client, point);
    return true;
}

module.exports = { connectTo, evaluate, grantFixtureTrust, click, waitFor };
