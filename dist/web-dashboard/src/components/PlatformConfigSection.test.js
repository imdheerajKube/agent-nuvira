"use strict";
/**
 * PlatformConfigSection tests — the Channels-tab transport config forms
 * (GUI parity with `buff config gateway`). Mocks the API, drives the expand →
 * edit → save → refresh flow, the remove flow, and the viewer gate.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const PlatformConfigSection_1 = require("./PlatformConfigSection");
const api_1 = require("../api");
const FIXTURES = [
    {
        platform: 'telegram',
        label: 'Telegram',
        configured: true,
        envVars: [{ varName: 'BUFF_TELEGRAM_TOKEN', set: true, value: '123:ABC', prompt: 'Telegram bot token', secret: true }],
    },
    {
        platform: 'matrix',
        label: 'Matrix (homeserver API)',
        configured: false,
        envVars: [
            { varName: 'BUFF_MATRIX_HOMESERVER', set: false, value: '', prompt: 'Matrix homeserver base URL', secret: false },
            { varName: 'BUFF_MATRIX_ACCESS_TOKEN', set: false, value: '', prompt: 'Matrix access token', secret: true },
        ],
    },
];
function mockApi(overrides = {}) {
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'getPlatformConfigs').mockResolvedValue(FIXTURES);
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'setPlatformConfig').mockResolvedValue(overrides.setResult ?? { ok: true });
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'removePlatformConfig').mockResolvedValue({ ok: true });
}
(0, vitest_1.afterEach)(() => {
    (0, react_1.cleanup)();
    vitest_1.vi.restoreAllMocks();
    vitest_1.vi.stubGlobal('confirm', undefined);
});
(0, vitest_1.describe)('PlatformConfigSection', () => {
    (0, vitest_1.it)('lists platforms with status and unset hints', async () => {
        mockApi();
        (0, react_1.render)(<PlatformConfigSection_1.PlatformConfigSection canWrite sessionExpired={() => { }}/>);
        (0, vitest_1.expect)(await react_1.screen.findByText('Telegram')).toBeTruthy();
        (0, vitest_1.expect)(await react_1.screen.findByText('Matrix (homeserver API)')).toBeTruthy();
        (0, vitest_1.expect)(await react_1.screen.findByText('BUFF_TELEGRAM_TOKEN')).toBeTruthy();
    });
    (0, vitest_1.it)('expands a platform, saves edited values, and refreshes', async () => {
        mockApi();
        const sessionExpired = vitest_1.vi.fn();
        (0, react_1.render)(<PlatformConfigSection_1.PlatformConfigSection canWrite sessionExpired={sessionExpired}/>);
        const configure = await react_1.screen.findAllByRole('button', { name: /⚙ Configure/ });
        react_1.fireEvent.click(configure[0]); // matrix (unconfigured)
        const urlInput = await react_1.screen.findByPlaceholderText('value');
        react_1.fireEvent.change(urlInput, { target: { value: 'https://matrix.org' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /💾 Save/ }));
        await (0, react_1.waitFor)(() => {
            (0, vitest_1.expect)(api_1.dashboardAPI.setPlatformConfig).toHaveBeenCalledWith('matrix', {
                BUFF_MATRIX_HOMESERVER: 'https://matrix.org',
                BUFF_MATRIX_ACCESS_TOKEN: '',
            });
        });
        (0, vitest_1.expect)(api_1.dashboardAPI.getPlatformConfigs).toHaveBeenCalledTimes(2); // initial + after save
        (0, vitest_1.expect)(sessionExpired).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('removes a configured platform after confirmation', async () => {
        vitest_1.vi.stubGlobal('confirm', () => true);
        mockApi();
        (0, react_1.render)(<PlatformConfigSection_1.PlatformConfigSection canWrite sessionExpired={() => { }}/>);
        const edit = await react_1.screen.findAllByRole('button', { name: /✎ Edit/ });
        react_1.fireEvent.click(edit[0]); // telegram (configured)
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /🗑 Remove/ }));
        await (0, react_1.waitFor)(() => {
            (0, vitest_1.expect)(api_1.dashboardAPI.removePlatformConfig).toHaveBeenCalledWith('telegram');
        });
    });
    (0, vitest_1.it)('disables configure/edit for viewers (no write access)', async () => {
        mockApi();
        (0, react_1.render)(<PlatformConfigSection_1.PlatformConfigSection canWrite={false} sessionExpired={() => { }}/>);
        await react_1.screen.findByText('Telegram');
        const buttons = react_1.screen.getAllByRole('button');
        for (const b of buttons) {
            (0, vitest_1.expect)(b.disabled).toBe(true);
        }
    });
    (0, vitest_1.it)('surfaces save errors', async () => {
        mockApi({ setResult: { ok: false, error: 'Save failed.' } });
        (0, react_1.render)(<PlatformConfigSection_1.PlatformConfigSection canWrite sessionExpired={() => { }}/>);
        const configure = await react_1.screen.findAllByRole('button', { name: /⚙ Configure/ });
        react_1.fireEvent.click(configure[0]);
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /💾 Save/ }));
        (0, vitest_1.expect)(await react_1.screen.findByText(/Save failed/)).toBeTruthy();
    });
    (0, vitest_1.it)('triggers sessionExpired on an auth failure from save', async () => {
        mockApi();
        const authSpy = vitest_1.vi
            .spyOn(api_1.dashboardAPI, 'setPlatformConfig')
            .mockResolvedValue({ ok: false, error: 'Not authenticated.', unauthorized: true });
        const sessionExpired = vitest_1.vi.fn();
        (0, react_1.render)(<PlatformConfigSection_1.PlatformConfigSection canWrite sessionExpired={sessionExpired}/>);
        const configure = await react_1.screen.findAllByRole('button', { name: /⚙ Configure/ });
        react_1.fireEvent.click(configure[0]);
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /💾 Save/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(authSpy).toHaveBeenCalled());
        (0, vitest_1.expect)(sessionExpired).toHaveBeenCalled();
    });
});
