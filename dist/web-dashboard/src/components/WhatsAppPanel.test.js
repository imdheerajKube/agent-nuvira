"use strict";
/**
 * P2 — WhatsAppPanel tests (in-page pairing UI).
 *
 * The panel renders the bridge pairing state, gates pair/cancel/unpair behind
 * the admin session + routing.operate, and shows the live QR / pairing code
 * while a session is active. API calls are mocked — no server, no network.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const WhatsAppPanel_1 = __importDefault(require("./WhatsAppPanel"));
const api_1 = require("../api");
const IDLE = {
    state: 'idle',
    paired: false,
    sessionDir: '/tmp/wa-session',
    qr: null,
    qrRaw: null,
    pairingCode: null,
    phone: null,
    error: null,
    startedAt: null,
};
const PAIRED = { ...IDLE, state: 'paired', paired: true };
const PAIRING_QR = {
    ...IDLE,
    state: 'pairing',
    qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    qrRaw: '2@payload',
    startedAt: Date.now(),
};
function mockStatus(status, contacts = {}) {
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'getWhatsAppStatus').mockResolvedValue({ status, contacts });
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeWhatsApp').mockReturnValue(() => { });
}
(0, vitest_1.afterEach)(() => {
    (0, react_1.cleanup)();
    vitest_1.vi.restoreAllMocks();
    (0, api_1.setAdminToken)(null);
});
(0, vitest_1.describe)('WhatsAppPanel', () => {
    (0, vitest_1.it)('shows the idle state with a pair button for an admin', async () => {
        mockStatus(IDLE);
        (0, react_1.render)(<WhatsAppPanel_1.default authed canWrite sessionExpired={() => { }}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('Not paired')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Pair with a QR/ })).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/918844433322/)).toBeTruthy();
        // The pair-by-number button is disabled until a number is typed.
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: 'Pair by number' })).toHaveProperty('disabled', true);
    });
    (0, vitest_1.it)('gates writes behind the admin session', async () => {
        mockStatus(IDLE);
        (0, react_1.render)(<WhatsAppPanel_1.default authed={false} canWrite={false} sessionExpired={() => { }}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('Not paired')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /Pair with a QR/ })).toBeNull();
        (0, vitest_1.expect)(react_1.screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy();
    });
    (0, vitest_1.it)('lets a viewer read status but not change it', async () => {
        mockStatus(PAIRED);
        (0, react_1.render)(<WhatsAppPanel_1.default authed canWrite={false} sessionExpired={() => { }}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('✅ Paired')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText(/can view pairing status but not change it/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /Unpair/ })).toBeNull();
    });
    (0, vitest_1.it)('renders the live QR image during a pairing session', async () => {
        mockStatus(PAIRING_QR);
        (0, react_1.render)(<WhatsAppPanel_1.default authed canWrite sessionExpired={() => { }}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByAltText('WhatsApp pairing QR code')).toBeTruthy());
        const img = react_1.screen.getByAltText('WhatsApp pairing QR code');
        (0, vitest_1.expect)(img.src).toContain('data:image/png;base64');
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Cancel pairing/ })).toBeTruthy();
    });
    (0, vitest_1.it)('starts a QR pairing on button click', async () => {
        mockStatus(IDLE);
        const start = vitest_1.vi.spyOn(api_1.dashboardAPI, 'startWhatsAppPair').mockResolvedValue({ ok: true });
        (0, react_1.render)(<WhatsAppPanel_1.default authed canWrite sessionExpired={() => { }}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Pair with a QR/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Pair with a QR/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(start).toHaveBeenCalledWith(undefined));
    });
    (0, vitest_1.it)('starts a phone pairing with the typed number', async () => {
        mockStatus(IDLE);
        const start = vitest_1.vi.spyOn(api_1.dashboardAPI, 'startWhatsAppPair').mockResolvedValue({ ok: true });
        (0, react_1.render)(<WhatsAppPanel_1.default authed canWrite sessionExpired={() => { }}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/918844433322/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/918844433322/), { target: { value: '918844433322' } });
        const btn = react_1.screen.getByRole('button', { name: 'Pair by number' });
        (0, vitest_1.expect)(btn.disabled).toBe(false);
        react_1.fireEvent.click(btn);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(start).toHaveBeenCalledWith('918844433322'));
    });
    (0, vitest_1.it)('offers unpair when paired', async () => {
        mockStatus(PAIRED);
        const unpair = vitest_1.vi.spyOn(api_1.dashboardAPI, 'unpairWhatsApp').mockResolvedValue({ ok: true });
        vitest_1.vi.spyOn(window, 'confirm').mockReturnValue(true);
        (0, react_1.render)(<WhatsAppPanel_1.default authed canWrite sessionExpired={() => { }}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Unpair/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Unpair/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(unpair).toHaveBeenCalled());
    });
    (0, vitest_1.it)('lists send-by-name contacts and clarifies they do NOT grant trigger access', async () => {
        mockStatus(PAIRED, { Alex: '919876543210', Ria: '918877766655' });
        (0, react_1.render)(<WhatsAppPanel_1.default authed canWrite sessionExpired={() => { }}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('📇 Send-by-name contacts')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('2 mapped')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('Alex')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('Ria')).toBeTruthy();
        // The clarity note — send-by-name ≠ trigger access.
        (0, vitest_1.expect)(react_1.screen.getByText(/let these numbers trigger the agent/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/verified list/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/buff config gateway allow whatsapp user/)).toBeTruthy();
    });
    (0, vitest_1.it)('shows an empty state when no contacts are mapped', async () => {
        mockStatus(PAIRED, {});
        (0, react_1.render)(<WhatsAppPanel_1.default authed canWrite sessionExpired={() => { }}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/none — add one with/)).toBeTruthy());
    });
});
