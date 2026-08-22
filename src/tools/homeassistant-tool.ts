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

import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

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
  context: { id: string; parent_id?: string };
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

// ─── Home Assistant Client ────────────────────────────────────────────────

export class HomeAssistantClient {
  private config: HAConfig;

  // Blocked service domains for security
  private blockedDomains = new Set([
    'shell_command', 'command_line', 'python_script', 'pyscript', 'hassio', 'rest_command',
  ]);

  constructor(config: HAConfig) {
    this.config = { url: config.url.replace(/\/$/, ''), token: config.token };
  }

  /**
   * Make a HA API request.
   */
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.config.url}/api${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.token}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`HA API ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  /**
   * List all entities, optionally filtered by domain.
   */
  async listEntities(domain?: string): Promise<HAEntity[]> {
    const states: HAEntity[] = await this.request('GET', '/states');
    if (domain) {
      return states.filter((e) => e.entity_id.startsWith(`${domain}.`));
    }
    return states;
  }

  /**
   * Get state of a specific entity.
   */
  async getState(entityId: string): Promise<HAEntity> {
    return this.request('GET', `/states/${entityId}`);
  }

  /**
   * List available services.
   */
  async listServices(): Promise<HAService[]> {
    return this.request('GET', '/services');
  }

  /**
   * List services for a specific domain.
   */
  async listDomainServices(domain: string): Promise<Record<string, any>> {
    const services: HAService[] = await this.request('GET', '/services');
    const domainService = services.find((s) => s.domain === domain);
    return domainService?.services || {};
  }

  /**
   * Call a HA service.
   */
  async callService(domain: string, service: string, entityId: string, data: Record<string, unknown> = {}): Promise<void> {
    // Security check: block dangerous domains
    if (this.blockedDomains.has(domain)) {
      throw new Error(`Service domain '${domain}' is blocked for security reasons`);
    }

    await this.request('POST', `/services/${domain}/${service}`, {
      entity_id: entityId,
      ...data,
    });

    logger.info(`[ha] Called ${domain}.${service} on ${entityId}`);
  }

  /**
   * Turn on an entity.
   */
  async turnOn(entityId: string, data: Record<string, unknown> = {}): Promise<void> {
    const domain = entityId.split('.')[0];
    await this.callService(domain, 'turn_on', entityId, data);
  }

  /**
   * Turn off an entity.
   */
  async turnOff(entityId: string): Promise<void> {
    const domain = entityId.split('.')[0];
    await this.callService(domain, 'turn_off', entityId);
  }

  /**
   * Toggle an entity.
   */
  async toggle(entityId: string): Promise<void> {
    const domain = entityId.split('.')[0];
    await this.callService(domain, 'toggle', entityId);
  }

  /**
   * Get HA config.
   */
  async getConfig(): Promise<Record<string, unknown>> {
    return this.request('GET', '/config');
  }

  /**
   * Get HA event history.
   */
  async getHistory(entityId: string, startTime: string): Promise<HAEntity[]> {
    return this.request('GET', `/history/period/${startTime}?filter_entity_id=${entityId}`);
  }

  /**
   * Validate entity ID format.
   */
  static isValidEntityId(entityId: string): boolean {
    return /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/.test(entityId);
  }

  /**
   * Validate service/domain name format.
   */
  static isValidServiceName(name: string): boolean {
    return /^[a-z][a-z0-9_]*$/.test(name);
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _haClient: HomeAssistantClient | null = null;

export function getHomeAssistantClient(url?: string, token?: string): HomeAssistantClient {
  if (!_haClient || url || token) {
    const haUrl = url || process.env.HASS_URL || 'http://homeassistant.local:8123';
    const haToken = token || process.env.HASS_TOKEN || '';
    _haClient = new HomeAssistantClient({ url: haUrl, token: haToken });
  }
  return _haClient;
}

export function resetHomeAssistantClient(): void {
  _haClient = null;
}
