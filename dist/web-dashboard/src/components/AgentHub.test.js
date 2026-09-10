"use strict";
/**
 * Agent Hub panel tests (I4 + I5).
 *
 * - 4 tabs render from the /api/hub payload (Tools/Channels/Artifacts/Skills).
 * - An authenticated admin/operator can toggle a toolset — the switch calls
 *   setToolsetEnabled and the panel re-reads.
 * - An unauthenticated user is routed through the login gate, then the queued
 *   toggle is applied.
 * - Reads degrade to a friendly error, never a crash.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const AgentHub_1 = __importDefault(require("./AgentHub"));
const api_1 = require("../api");
const HUB = {
    toolsets: {
        toolsets: [
            { name: 'core', label: 'Core', description: 'Pipeline actions', enabled: true, tools: ['build', 'test'], toolCount: 2 },
            { name: 'web', label: 'Web research', description: 'Search + page reading', enabled: true, tools: ['web_search', 'read_page'], toolCount: 2 },
        ],
        enabled: 2,
        disabled: 0,
        totalTools: 4,
    },
    channels: {
        delivery: {
            total: 1,
            pending: 1,
            sent: 0,
            failed: 0,
            recent: [
                { id: 'e1', target: 'ops', platform: 'slack', channelId: 'C1', text: 'nightly done', status: 'pending', attempts: 2, nextAttemptAt: Date.now() + 30000, createdAt: Date.now() },
            ],
        },
        aliases: [{ alias: 'ops', platform: 'slack', channelId: 'C1', addedAt: Date.now() }],
        reachable: [],
        platforms: [
            { platform: 'email', label: 'Email (SMTP)', configured: false, envVars: ['BUFF_SMTP_HOST', 'BUFF_SMTP_USER'] },
            { platform: 'signal', label: 'Signal (signal-cli-rest-api)', configured: true, envVars: ['BUFF_SIGNAL_ACCOUNT'] },
            { platform: 'whatsapp', label: 'WhatsApp (Baileys bridge)', configured: true, envVars: ['BUFF_WHATSAPP_SESSION_DIR'] },
        ],
        policies: {
            whatsapp: { allowedUsers: ['+919876543210', '919999999999'], silentDrop: true },
        },
        contacts: [{ name: 'Alex', platform: 'whatsapp', id: '+919876543210', addedAt: Date.now() }],
        statusRecipients: [],
        statusRecipientDisplay: {},
        inbox: {
            total: 0,
            pipeline: 0,
            chat: 0,
            help: 0,
            refused: 0,
            recent: [],
        },
    },
    artifacts: {
        totalSessions: 1,
        totalArtifacts: 2,
        sessions: [
            { sessionId: 's1', count: 2, latestAt: Date.now(), recent: [{ kind: 'doc', title: 'deploy report', preview: 'published ok' }] },
        ],
    },
    skills: {
        compiled: [
            { id: 'skill-fix-lint', name: 'Fix lint', description: 'Fixes lint errors', version: '1.0.0', origin: 'compiled', usageCount: 3, bundled: true },
            { id: 'skill-custom-x', name: 'Custom X', description: 'A user-added skill', version: '1.0.0', origin: 'compiled', usageCount: 0, bundled: false },
        ],
        hub: [{ id: 'demo-fix', name: 'demo-fix', description: 'Fix a demo issue', origin: 'hub' }],
        total: 3,
    },
    adminConfigured: true,
    serverTime: 123,
};
/** The panel's mount-time fetches (hub + auth status). */
function mockReads(payload = HUB, auth = { configured: true, authenticated: true, role: 'admin' }) {
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchHub').mockResolvedValue(payload);
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
        configured: auth.configured,
        authenticated: auth.authenticated,
        user: auth.authenticated ? 'admin' : null,
        role: auth.authenticated ? (auth.role ?? 'admin') : null,
    });
    // The Channels tab mounts WhatsAppPanel (P2), whose SSE subscription needs
    // a browser EventSource — keep the hub tests hermetic.
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeWhatsApp').mockReturnValue(() => { });
    // …and PlatformConfigSection (v1.69) fetches the transport list on mount.
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'getPlatformConfigs').mockResolvedValue([]);
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'getWhatsAppStatus').mockResolvedValue({
        status: {
            state: 'idle',
            paired: false,
            sessionDir: '/tmp/wa-session',
            qr: null,
            qrRaw: null,
            pairingCode: null,
            phone: null,
            error: null,
            startedAt: null,
        },
        contacts: {},
    });
}
(0, vitest_1.afterEach)(() => {
    (0, react_1.cleanup)();
    vitest_1.vi.restoreAllMocks();
    (0, api_1.setAdminToken)(null);
});
(0, vitest_1.describe)('AgentHub', () => {
    (0, vitest_1.it)('renders the 4 tabs with counts from the hub payload', async () => {
        mockReads();
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Channels/ })).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Artifacts/ })).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Skills/ })).toBeTruthy();
        // Tab badges carry counts (2/2 toolsets, 1 channel, 1 session, 2 skills).
        (0, vitest_1.expect)(react_1.screen.getByText('2/2')).toBeTruthy();
    });
    (0, vitest_1.it)('shows a friendly error when the hub read fails', async () => {
        mockReads(null);
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Could not reach the dashboard server/)).toBeTruthy());
    });
    (0, vitest_1.it)('toggles a toolset when authed (admin)', async () => {
        mockReads();
        const setMock = vitest_1.vi.spyOn(api_1.dashboardAPI, 'setToolsetEnabled').mockResolvedValue({ ok: true });
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        const webSwitch = react_1.screen.getByRole('switch', { name: /Disable Web research/ });
        (0, vitest_1.expect)(webSwitch.disabled).toBe(false);
        react_1.fireEvent.click(webSwitch);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(setMock).toHaveBeenCalledWith('web', false));
    });
    (0, vitest_1.it)('queues the toggle behind the login gate when not authed, then applies it', async () => {
        mockReads(HUB, { configured: true, authenticated: false });
        const loginMock = vitest_1.vi.spyOn(api_1.dashboardAPI, 'adminLogin').mockResolvedValue({ ok: true, user: 'admin', token: 't' });
        const setMock = vitest_1.vi.spyOn(api_1.dashboardAPI, 'setToolsetEnabled').mockResolvedValue({ ok: true });
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        // Switch is disabled without auth — clicking queues the toggle.
        const webSwitch = react_1.screen.getByRole('switch', { name: /Disable Web research/ });
        react_1.fireEvent.click(webSwitch);
        // Login form appears (queued toggle named in the prompt).
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Log in to disable 'web'/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('••••••••'), { target: { value: 'secret-pass' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Log in & apply/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(loginMock).toHaveBeenCalled());
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(setMock).toHaveBeenCalledWith('web', false));
    });
    (0, vitest_1.it)('I11: authed admin can send a test message from the Channels tab', async () => {
        mockReads();
        const sendMock = vitest_1.vi.spyOn(api_1.dashboardAPI, 'sendChannelMessage').mockResolvedValue({ ok: true, platform: 'slack', channelId: 'C1' });
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Channels/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Test a channel/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('ops or slack:C0123 or email:team@example.com'), { target: { value: 'ops' } });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('nightly build done 🎉'), { target: { value: 'hello hub' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Send test message/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(sendMock).toHaveBeenCalledWith('ops', 'hello hub'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Sent to ops/)).toBeTruthy());
    });
    (0, vitest_1.it)('I11: a viewer role cannot send — inline error, no API call', async () => {
        mockReads(HUB, { configured: true, authenticated: true, role: 'viewer' });
        const sendMock = vitest_1.vi.spyOn(api_1.dashboardAPI, 'sendChannelMessage');
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Channels/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Test a channel/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('ops or slack:C0123 or email:team@example.com'), { target: { value: 'ops' } });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('nightly build done 🎉'), { target: { value: 'hello hub' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Send test message/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/cannot send channel messages/)).toBeTruthy());
        (0, vitest_1.expect)(sendMock).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('I11: an unauthenticated user is told to log in before sending', async () => {
        mockReads(HUB, { configured: true, authenticated: false });
        const sendMock = vitest_1.vi.spyOn(api_1.dashboardAPI, 'sendChannelMessage');
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Channels/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Test a channel/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('ops or slack:C0123 or email:team@example.com'), { target: { value: 'ops' } });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('nightly build done 🎉'), { target: { value: 'hello hub' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Send test message/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Log in .* to send test messages/)).toBeTruthy());
        (0, vitest_1.expect)(sendMock).not.toHaveBeenCalled();
    });
    /** The whatsapp card on the Permissions section (scoped — the label also renders in the transports list). */
    function whatsappCard() {
        const card = react_1.screen
            .getAllByText('WhatsApp (Baileys bridge)')
            .map((el) => el.closest('.hub-card'))
            .find((c) => !!c);
        (0, vitest_1.expect)(card).toBeTruthy();
        return card;
    }
    (0, vitest_1.it)('Permissions: adding a verified user shows the MASKED id (no name, no full number)', async () => {
        mockReads();
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Channels/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Saved contacts \(validated list\)/)).toBeTruthy());
        const card = whatsappCard();
        react_1.fireEvent.change((0, react_1.within)(card).getByPlaceholderText('Name (optional)'), { target: { value: 'Sam' } });
        react_1.fireEvent.change((0, react_1.within)(card).getByPlaceholderText('Contact no / sender id, or Allow-All'), { target: { value: '+919999999999' } });
        react_1.fireEvent.click((0, react_1.within)(card).getByRole('button', { name: /\+ User/ }));
        // The new chip shows the MASKED sender id with a pending marker — the
        // personal name and the full number must NOT appear anywhere.
        (0, vitest_1.expect)((0, react_1.within)(card).getByText(/\+91\*\*\*.*pending/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.queryByText('Sam')).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText('+919999999999')).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText('919999999999')).toBeNull();
        // The other saved users stay visible (masked too, no pending marker).
        (0, vitest_1.expect)((0, react_1.within)(card).getAllByText(/91\*\*\*/).length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('Permissions: adding a user shows the UNSAVED banner until Save is pressed', async () => {
        mockReads();
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Channels/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Saved contacts \(validated list\)/)).toBeTruthy());
        // No unsaved banner before any edit.
        (0, vitest_1.expect)(react_1.screen.queryByText(/Unsaved changes/)).toBeNull();
        const card = whatsappCard();
        react_1.fireEvent.change((0, react_1.within)(card).getByPlaceholderText('Name (optional)'), { target: { value: 'Sam' } });
        react_1.fireEvent.change((0, react_1.within)(card).getByPlaceholderText('Contact no / sender id, or Allow-All'), { target: { value: '+919999999999' } });
        react_1.fireEvent.click((0, react_1.within)(card).getByRole('button', { name: /\+ User/ }));
        // Draft edit → the banner appears, telling the user to press Save.
        (0, vitest_1.expect)(react_1.screen.getByText(/Unsaved changes/)).toBeTruthy();
        // Save persists and clears the banner (click the one INSIDE the banner).
        const save = vitest_1.vi.spyOn(api_1.dashboardAPI, 'saveGatewayPolicies').mockResolvedValue({ ok: true });
        const banner = react_1.screen.getByText(/Unsaved changes/).closest('.hub-unsaved-banner');
        react_1.fireEvent.click((0, react_1.within)(banner).getByRole('button', { name: /Save permissions/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(save).toHaveBeenCalled());
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByText(/Unsaved changes/)).toBeNull());
    });
    (0, vitest_1.it)('privacy: sender ids are masked by default; the admin toggle reveals full ids', async () => {
        mockReads();
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Channels/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Delivery ledger/)).toBeTruthy());
        // Masked by default — the full fixture number never appears.
        (0, vitest_1.expect)(react_1.screen.queryByText('+919876543210')).toBeNull();
        (0, vitest_1.expect)(react_1.screen.getAllByText(/\+91\*\*\*/).length).toBeGreaterThan(0);
        // Flip the admin-only toggle → full ids render (both fixture ids show).
        react_1.fireEvent.click(react_1.screen.getByRole('checkbox', { name: /Show full sender ids/ }));
        (0, vitest_1.expect)(react_1.screen.getAllByText('+919876543210').length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getAllByText('919999999999').length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('privacy: a viewer cannot toggle full sender ids', async () => {
        mockReads(HUB, { configured: true, authenticated: true, role: 'viewer' });
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Channels/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Delivery ledger/)).toBeTruthy());
        const toggle = react_1.screen.getByRole('checkbox', { name: /Show full sender ids/ });
        (0, vitest_1.expect)(toggle.disabled).toBe(true);
    });
    (0, vitest_1.it)('Permissions: removing ONE verified user keeps the rest of the saved list', async () => {
        // Regression: the draft is seeded from the SAVED list, so removing one
        // entry must not blank (and on save, silently delete) the others.
        mockReads();
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Channels/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Saved contacts \(validated list\)/)).toBeTruthy());
        const card = whatsappCard();
        // All ids render MASKED — remove the chip whose masked id is 91***.
        const maskedRows = (0, react_1.within)(card).getAllByText(/91\*\*\*/);
        const row = maskedRows[maskedRows.length - 1].closest('.hub-alias-row');
        react_1.fireEvent.click((0, react_1.within)(row).getByRole('button', { name: '✕' }));
        // The removed id is gone; at least one masked id remains.
        (0, vitest_1.expect)((0, react_1.within)(card).queryByText(/\+91\*\*\*/)).toBeTruthy();
    });
    (0, vitest_1.it)('switches tabs — Channels shows the delivery ledger, Skills shows skills', async () => {
        mockReads();
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Channels/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Delivery ledger/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('⏳ pending')).toBeTruthy();
        // Platform transports section shows the I6 adapters (the label also
        // appears as a chip on the Permissions cards below).
        (0, vitest_1.expect)(react_1.screen.getAllByText('Email (SMTP)').length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getAllByText('Signal (signal-cli-rest-api)').length).toBeGreaterThan(0);
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Artifacts/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/deploy report/)).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Skills/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('Fix lint')).toBeTruthy());
        // 'demo-fix' renders twice (skill name + id) — assert both are present.
        (0, vitest_1.expect)(react_1.screen.getAllByText('demo-fix')).toHaveLength(2);
    });
    (0, vitest_1.it)('P6e — provenance badges: bundled skills get 🧠, user-added get community', async () => {
        mockReads();
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Skills/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Skills/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('🧠 bundled')).toBeTruthy());
        // Fix lint (bundled) → 🧠 badge; Custom X (user-added) → community badge.
        const bundledCards = react_1.screen.getAllByText('🧠 bundled');
        (0, vitest_1.expect)(bundledCards.length).toBeGreaterThanOrEqual(1);
        (0, vitest_1.expect)(react_1.screen.getByText('community')).toBeTruthy();
    });
    (0, vitest_1.it)('P6d — marketplace: searches, shows results, and installs a skill', async () => {
        mockReads();
        const searchSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'marketplaceSearch').mockResolvedValue([
            { name: 'code-assist', version: '1.2.0', description: 'Assist with code edits', author: 'nvidia', tags: ['code', 'assist'], source: 'git-repo:https://github.com/x/skills', sourceKind: 'git-repo' },
        ]);
        const installSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'marketplaceInstall').mockResolvedValue({ ok: true });
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Skills/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Skills/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Search community skills/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Search community skills/), { target: { value: 'assist' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Search community skills/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(searchSpy).toHaveBeenCalledWith('assist'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('code-assist')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText(/v1\.2\.0 · git-repo/)).toBeTruthy();
        react_1.fireEvent.click(react_1.screen.getByText('⬇ Install'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(installSpy).toHaveBeenCalledWith('code-assist'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Installed code-assist/)).toBeTruthy());
    });
    (0, vitest_1.it)('P6d — uninstalls a hub skill from the Skills list', async () => {
        mockReads();
        const uninstallSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'marketplaceUninstall').mockResolvedValue({ ok: true });
        (0, react_1.render)(<AgentHub_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('tab', { name: /Skills/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('tab', { name: /Skills/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getAllByText('demo-fix').length).toBeGreaterThanOrEqual(2));
        react_1.fireEvent.click(react_1.screen.getByText('🗑 Uninstall'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(uninstallSpy).toHaveBeenCalledWith('demo-fix'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Uninstalled demo-fix/)).toBeTruthy());
    });
});
