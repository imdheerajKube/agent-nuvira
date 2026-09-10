"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * QuotaPanel tests (Session 36 — user-declared daily budget).
 *
 * Covers: provider rows + the TPD callout, pre-fill of declared limits,
 * viewer read-only gating, admin save payload (routing.quota + cost cap),
 * and the operator partial permission (budget editable, cost cap locked).
 */
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const QuotaPanel_1 = __importDefault(require("./QuotaPanel"));
const api_1 = require("../api");
const QUOTA = {
    ok: true,
    quota: { groq: { tokensPerWindow: 12000 } },
    costUsd: 0.1,
    providers: ['groq', 'gemini', 'local'],
};
function mockFetch(config = QUOTA) {
    return vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminQuota').mockResolvedValue(config);
}
(0, vitest_1.describe)('QuotaPanel', () => {
    (0, vitest_1.afterEach)(() => {
        (0, react_1.cleanup)();
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)('renders every provider row + the TPD callout', async () => {
        mockFetch();
        (0, react_1.render)(<QuotaPanel_1.default authed={false} role="viewer"/>);
        (0, vitest_1.expect)(await react_1.screen.findByText(/Daily Budget/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('groq')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('gemini')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('local')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/tokens-per.*day/)).toBeTruthy();
    });
    (0, vitest_1.it)('pre-fills declared limits and the cost cap', async () => {
        mockFetch();
        (0, react_1.render)(<QuotaPanel_1.default authed={false} role="viewer"/>);
        (0, vitest_1.expect)((await react_1.screen.findAllByDisplayValue('12000')).length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getByDisplayValue('0.1')).toBeTruthy();
    });
    (0, vitest_1.it)('viewer sees read-only inputs and the read-only note', async () => {
        mockFetch();
        (0, react_1.render)(<QuotaPanel_1.default authed={true} role="viewer"/>);
        const firstInput = (await react_1.screen.findAllByPlaceholderText('unset'))[0];
        (0, vitest_1.expect)(firstInput.disabled).toBe(true);
        (0, vitest_1.expect)(react_1.screen.getByText(/Read-only for/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.queryByText('💾 Save budget')).toBeNull();
    });
    (0, vitest_1.it)('admin can save — saveAdminQuota receives the declared budget', async () => {
        mockFetch();
        const save = vitest_1.vi.spyOn(api_1.dashboardAPI, 'saveAdminQuota').mockResolvedValue({ ok: true });
        (0, react_1.render)(<QuotaPanel_1.default authed={true} role="admin"/>);
        react_1.fireEvent.change(await react_1.screen.findByDisplayValue('12000'), { target: { value: '20000' } });
        react_1.fireEvent.click(react_1.screen.getByText('💾 Save budget'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(save).toHaveBeenCalled());
        const payload = save.mock.calls[0][0];
        (0, vitest_1.expect)(payload.quota.groq.tokensPerWindow).toBe(20000);
        (0, vitest_1.expect)(payload.costUsd).toBe(0.1);
    });
    (0, vitest_1.it)('operator can edit budget fields but the cost cap input stays locked', async () => {
        mockFetch();
        (0, react_1.render)(<QuotaPanel_1.default authed={true} role="operator"/>);
        await react_1.screen.findByDisplayValue('12000');
        (0, vitest_1.expect)(react_1.screen.getByText('💾 Save budget')).toBeTruthy();
        const costInput = react_1.screen.getByDisplayValue('0.1');
        (0, vitest_1.expect)(costInput.disabled).toBe(true);
    });
    (0, vitest_1.it)('operator save payload OMITS costUsd — the server gates it on policy.write (admin)', async () => {
        mockFetch();
        const save = vitest_1.vi.spyOn(api_1.dashboardAPI, 'saveAdminQuota').mockResolvedValue({ ok: true });
        (0, react_1.render)(<QuotaPanel_1.default authed={true} role="operator"/>);
        react_1.fireEvent.change(await react_1.screen.findByDisplayValue('12000'), { target: { value: '9000' } });
        react_1.fireEvent.click(react_1.screen.getByText('💾 Save budget'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(save).toHaveBeenCalled());
        const payload = save.mock.calls[0][0];
        (0, vitest_1.expect)(payload.costUsd).toBeUndefined(); // operator must never send the cap
        const quota = payload.quota;
        (0, vitest_1.expect)(quota.groq.tokensPerWindow).toBe(9000);
    });
});
