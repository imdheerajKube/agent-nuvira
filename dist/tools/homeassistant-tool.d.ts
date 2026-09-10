/**
 * Home Assistant Tool — Control smart home devices via REST API.
 *
 * Hermes equivalent: homeassistant_tool.py (514 lines)
 *
 * Provides:
 * - List/filter entities by domain or area
 * - Get detailed state of entities
 * - List available services per domain
 * - Call HA services (turn_on, turn_off, set_temperature, etc.)
 */
export interface HAConfig {
    url: string;
    token: string;
}
export interface HAEntity {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
    last_changed: string;
    last_updated: string;
    context: {
        id: string;
        parent_id?: string;
    };
}
export interface HAService {
    domain: string;
    services: Record<string, {
        name: string;
        description: string;
        fields: Record<string, {
            name: string;
            description: string;
            required?: boolean;
            example?: string;
        }>;
    }>;
}
export declare class HomeAssistantClient {
    private config;
    private blockedDomains;
    constructor(config: HAConfig);
    /**
     * Make a HA API request.
     */
    private request;
    /**
     * List all entities, optionally filtered by domain.
     */
    listEntities(domain?: string): Promise<HAEntity[]>;
    /**
     * Get state of a specific entity.
     */
    getState(entityId: string): Promise<HAEntity>;
    /**
     * List available services.
     */
    listServices(): Promise<HAService[]>;
    /**
     * List services for a specific domain.
     */
    listDomainServices(domain: string): Promise<Record<string, any>>;
    /**
     * Call a HA service.
     */
    callService(domain: string, service: string, entityId: string, data?: Record<string, unknown>): Promise<void>;
    /**
     * Turn on an entity.
     */
    turnOn(entityId: string, data?: Record<string, unknown>): Promise<void>;
    /**
     * Turn off an entity.
     */
    turnOff(entityId: string): Promise<void>;
    /**
     * Toggle an entity.
     */
    toggle(entityId: string): Promise<void>;
    /**
     * Get HA config.
     */
    getConfig(): Promise<Record<string, unknown>>;
    /**
     * Get HA event history.
     */
    getHistory(entityId: string, startTime: string): Promise<HAEntity[]>;
    /**
     * Validate entity ID format.
     */
    static isValidEntityId(entityId: string): boolean;
    /**
     * Validate service/domain name format.
     */
    static isValidServiceName(name: string): boolean;
}
export declare function getHomeAssistantClient(url?: string, token?: string): HomeAssistantClient;
export declare function resetHomeAssistantClient(): void;
//# sourceMappingURL=homeassistant-tool.d.ts.map