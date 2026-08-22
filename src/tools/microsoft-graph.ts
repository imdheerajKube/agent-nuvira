/**
 * Microsoft Graph Tools — Outlook, OneDrive, Calendar integration.
 *
 * Hermes equivalents:
 * - microsoft_graph_auth.py (245 lines) — OAuth2 token management
 * - microsoft_graph_client.py (400 lines) — REST client with retries
 *
 * Provides:
 * - Email management (read, send, search)
 * - Calendar events (list, create, update)
 * - OneDrive files (list, upload, download)
 * - Contacts management
 */

import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface GraphConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  accessToken?: string;
}

export interface GraphEmail {
  id: string;
  subject: string;
  bodyPreview: string;
  from: { emailAddress: { address: string; name: string } };
  toRecipients: Array<{ emailAddress: { address: string; name: string } }>;
  receivedDateTime: string;
  isRead: boolean;
  importance: string;
}

export interface GraphEvent {
  id: string;
  subject: string;
  body?: { content: string; contentType: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  attendees: Array<{ emailAddress: { address: string; name: string }; status: { response: string } }>;
}

export interface GraphFile {
  id: string;
  name: string;
  size: number;
  createdDateTime: string;
  lastModifiedDateTime: string;
  webUrl: string;
  file?: { mimeType: string };
  folder?: { childCount: number };
}

// ─── Microsoft Graph Client ───────────────────────────────────────────────

export class MicrosoftGraphClient {
  private config: GraphConfig;
  private baseUrl = 'https://graph.microsoft.com/v1.0';

  constructor(config: GraphConfig) {
    this.config = config;
  }

  /**
   * Get access token using client credentials.
   */
  async getAccessToken(): Promise<string> {
    if (this.config.accessToken) return this.config.accessToken;

    const response = await fetch(`https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token request failed: ${error}`);
    }

    const data = await response.json() as { access_token: string };
    this.config.accessToken = data.access_token;
    return data.access_token;
  }

  /**
   * Make a Graph API request.
   */
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Graph API ${response.status}: ${errorText}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  // ─── Email Operations ─────────────────────────────────────────────

  /**
   * List emails.
   */
  async listEmails(options: { folder?: string; top?: number; filter?: string } = {}): Promise<GraphEmail[]> {
    let path = `/me/mailFolders/${options.folder || 'inbox'}/messages?$top=${options.top || 20}`;
    if (options.filter) path += `&$filter=${encodeURIComponent(options.filter)}`;
    const result = await this.request('GET', path);
    return result.value || [];
  }

  /**
   * Get email by ID.
   */
  async getEmail(messageId: string): Promise<GraphEmail> {
    return this.request('GET', `/me/messages/${messageId}`);
  }

  /**
   * Send email.
   */
  async sendEmail(options: {
    to: string[];
    subject: string;
    body: string;
    importance?: 'low' | 'normal' | 'high';
  }): Promise<void> {
    await this.request('POST', '/me/sendMail', {
      message: {
        subject: options.subject,
        body: { contentType: 'Text', content: options.body },
        toRecipients: options.to.map((addr) => ({
          emailAddress: { address: addr },
        })),
        importance: options.importance || 'normal',
      },
    });
  }

  /**
   * Reply to email.
   */
  async replyToEmail(messageId: string, comment: string): Promise<void> {
    await this.request('POST', `/me/messages/${messageId}/reply`, { comment });
  }

  /**
   * Mark email as read.
   */
  async markAsRead(messageId: string): Promise<void> {
    await this.request('PATCH', `/me/messages/${messageId}`, { isRead: true });
  }

  /**
   * Delete email.
   */
  async deleteEmail(messageId: string): Promise<void> {
    await this.request('DELETE', `/me/messages/${messageId}`);
  }

  // ─── Calendar Operations ──────────────────────────────────────────

  /**
   * List calendar events.
   */
  async listEvents(options: { top?: number; filter?: string } = {}): Promise<GraphEvent[]> {
    let path = `/me/events?$top=${options.top || 20}`;
    if (options.filter) path += `&$filter=${encodeURIComponent(options.filter)}`;
    const result = await this.request('GET', path);
    return result.value || [];
  }

  /**
   * Create calendar event.
   */
  async createEvent(options: {
    subject: string;
    start: string;
    end: string;
    body?: string;
    attendees?: string[];
    location?: string;
  }): Promise<GraphEvent> {
    return this.request('POST', '/me/events', {
      subject: options.subject,
      body: options.body ? { contentType: 'Text', content: options.body } : undefined,
      start: { dateTime: options.start, timeZone: 'UTC' },
      end: { dateTime: options.end, timeZone: 'UTC' },
      location: options.location ? { displayName: options.location } : undefined,
      attendees: options.attendees?.map((addr) => ({
        emailAddress: { address: addr },
        type: 'required',
      })),
    });
  }

  /**
   * Delete calendar event.
   */
  async deleteEvent(eventId: string): Promise<void> {
    await this.request('DELETE', `/me/events/${eventId}`);
  }

  // ─── OneDrive Operations ──────────────────────────────────────────

  /**
   * List OneDrive files.
   */
  async listFiles(path: string = '/', top: number = 20): Promise<GraphFile[]> {
    const result = await this.request('GET', `/me/drive/root:${path}:/children?$top=${top}`);
    return result.value || [];
  }

  /**
   * Upload file to OneDrive.
   */
  async uploadFile(drivePath: string, content: string): Promise<GraphFile> {
    return this.request('PUT', `/me/drive/root:${drivePath}:/content`, content);
  }

  /**
   * Download file from OneDrive.
   */
  async downloadFile(drivePath: string): Promise<string> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}/me/drive/root:${drivePath}:/content`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return response.text();
  }

  /**
   * Delete file from OneDrive.
   */
  async deleteFile(drivePath: string): Promise<void> {
    await this.request('DELETE', `/me/drive/root:${drivePath}`);
  }

  // ─── Contacts Operations ──────────────────────────────────────────

  /**
   * List contacts.
   */
  async listContacts(top: number = 20): Promise<Array<{ id: string; displayName: string; emailAddresses: Array<{ address: string }> }>> {
    const result = await this.request('GET', `/me/contacts?$top=${top}`);
    return result.value || [];
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _graphClient: MicrosoftGraphClient | null = null;

export function getMicrosoftGraphClient(config?: GraphConfig): MicrosoftGraphClient {
  if (!_graphClient || config) {
    _graphClient = new MicrosoftGraphClient(config || {
      clientId: process.env.MICROSOFT_CLIENT_ID || '',
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
      tenantId: process.env.MICROSOFT_TENANT_ID || '',
    });
  }
  return _graphClient;
}

export function resetMicrosoftGraphClient(): void {
  _graphClient = null;
}
