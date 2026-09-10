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
// ─── Microsoft Graph Client ───────────────────────────────────────────────
export class MicrosoftGraphClient {
    config;
    baseUrl = 'https://graph.microsoft.com/v1.0';
    constructor(config) {
        this.config = config;
    }
    /**
     * Get access token using client credentials.
     */
    async getAccessToken() {
        if (this.config.accessToken)
            return this.config.accessToken;
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
        const data = await response.json();
        this.config.accessToken = data.access_token;
        return data.access_token;
    }
    /**
     * Make a Graph API request.
     */
    async request(method, path, body) {
        const token = await this.getAccessToken();
        const url = `${this.baseUrl}${path}`;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        };
        const options = { method, headers };
        if (body)
            options.body = JSON.stringify(body);
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`Graph API ${response.status}: ${errorText}`);
        }
        if (response.status === 204)
            return null;
        return response.json();
    }
    // ─── Email Operations ─────────────────────────────────────────────
    /**
     * List emails.
     */
    async listEmails(options = {}) {
        let path = `/me/mailFolders/${options.folder || 'inbox'}/messages?$top=${options.top || 20}`;
        if (options.filter)
            path += `&$filter=${encodeURIComponent(options.filter)}`;
        const result = await this.request('GET', path);
        return result.value || [];
    }
    /**
     * Get email by ID.
     */
    async getEmail(messageId) {
        return this.request('GET', `/me/messages/${messageId}`);
    }
    /**
     * Send email.
     */
    async sendEmail(options) {
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
    async replyToEmail(messageId, comment) {
        await this.request('POST', `/me/messages/${messageId}/reply`, { comment });
    }
    /**
     * Mark email as read.
     */
    async markAsRead(messageId) {
        await this.request('PATCH', `/me/messages/${messageId}`, { isRead: true });
    }
    /**
     * Delete email.
     */
    async deleteEmail(messageId) {
        await this.request('DELETE', `/me/messages/${messageId}`);
    }
    // ─── Calendar Operations ──────────────────────────────────────────
    /**
     * List calendar events.
     */
    async listEvents(options = {}) {
        let path = `/me/events?$top=${options.top || 20}`;
        if (options.filter)
            path += `&$filter=${encodeURIComponent(options.filter)}`;
        const result = await this.request('GET', path);
        return result.value || [];
    }
    /**
     * Create calendar event.
     */
    async createEvent(options) {
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
    async deleteEvent(eventId) {
        await this.request('DELETE', `/me/events/${eventId}`);
    }
    // ─── OneDrive Operations ──────────────────────────────────────────
    /**
     * List OneDrive files.
     */
    async listFiles(path = '/', top = 20) {
        const result = await this.request('GET', `/me/drive/root:${path}:/children?$top=${top}`);
        return result.value || [];
    }
    /**
     * Upload file to OneDrive.
     */
    async uploadFile(drivePath, content) {
        return this.request('PUT', `/me/drive/root:${drivePath}:/content`, content);
    }
    /**
     * Download file from OneDrive.
     */
    async downloadFile(drivePath) {
        const token = await this.getAccessToken();
        const url = `${this.baseUrl}/me/drive/root:${drivePath}:/content`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!response.ok)
            throw new Error(`Download failed: ${response.status}`);
        return response.text();
    }
    /**
     * Delete file from OneDrive.
     */
    async deleteFile(drivePath) {
        await this.request('DELETE', `/me/drive/root:${drivePath}`);
    }
    // ─── Contacts Operations ──────────────────────────────────────────
    /**
     * List contacts.
     */
    async listContacts(top = 20) {
        const result = await this.request('GET', `/me/contacts?$top=${top}`);
        return result.value || [];
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _graphClient = null;
export function getMicrosoftGraphClient(config) {
    if (!_graphClient || config) {
        _graphClient = new MicrosoftGraphClient(config || {
            clientId: process.env.MICROSOFT_CLIENT_ID || '',
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
            tenantId: process.env.MICROSOFT_TENANT_ID || '',
        });
    }
    return _graphClient;
}
export function resetMicrosoftGraphClient() {
    _graphClient = null;
}
//# sourceMappingURL=microsoft-graph.js.map