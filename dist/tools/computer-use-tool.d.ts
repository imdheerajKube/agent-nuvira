/**
 * computer_use — Universal desktop control via cua-driver.
 *
 * Background computer-use: does NOT steal the user's cursor or keyboard focus.
 * Works with any tool-capable model. Preferred workflow:
 *   1. capture(mode='som') for numbered element overlays
 *   2. click(element=N) for reliable interaction
 *   3. Pixel coordinates as fallback for models trained on them
 *
 * Supports macOS, Windows, and Linux via cua-driver backend.
 */
type ComputerUseAction = 'capture' | 'click' | 'double_click' | 'right_click' | 'middle_click' | 'drag' | 'scroll' | 'type' | 'key' | 'set_value' | 'wait' | 'list_apps' | 'list_windows' | 'focus_app' | 'health';
declare class ComputerUseTool {
    private backend;
    private sessionApproved;
    constructor();
    /**
     * Execute a computer use action.
     */
    execute(action: ComputerUseAction, args: Record<string, any>): Promise<any>;
    /**
     * Approve the session for destructive actions.
     */
    approveSession(): void;
    /**
     * Revoke session approval.
     */
    revokeApproval(): void;
    /**
     * Get health status.
     */
    health(): Promise<any>;
    /**
     * List available actions.
     */
    getActions(): string[];
}
export declare function getComputerUseTool(): ComputerUseTool;
export { ComputerUseTool };
//# sourceMappingURL=computer-use-tool.d.ts.map