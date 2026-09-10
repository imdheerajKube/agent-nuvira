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
    from: {
        emailAddress: {
            address: string;
            name: string;
        };
    };
    toRecipients: Array<{
        emailAddress: {
            address: string;
            name: string;
        };
    }>;
    receivedDateTime: string;
    isRead: boolean;
    importance: string;
}
export interface GraphEvent {
    id: string;
    subject: string;
    body?: {
        content: string;
        contentType: string;
    };
    start: {
        dateTime: string;
        timeZone: string;
    };
    end: {
        dateTime: string;
        timeZone: string;
    };
    location?: {
        displayName: string;
    };
    attendees: Array<{
        emailAddress: {
            address: string;
            name: string;
        };
        status: {
            response: string;
        };
    }>;
}
export interface GraphFile {
    id: string;
    name: string;
    size: number;
    createdDateTime: string;
    lastModifiedDateTime: string;
    webUrl: string;
    file?: {
        mimeType: string;
    };
    folder?: {
        childCount: number;
    };
}
export declare class MicrosoftGraphClient {
    private config;
    private baseUrl;
    constructor(config: GraphConfig);
    /**
     * Get access token using client credentials.
     */
    getAccessToken(): Promise<string>;
    /**
     * Make a Graph API request.
     */
    private request;
    /**
     * List emails.
     */
    listEmails(options?: {
        folder?: string;
        top?: number;
        filter?: string;
    }): Promise<GraphEmail[]>;
    /**
     * Get email by ID.
     */
    getEmail(messageId: string): Promise<GraphEmail>;
    /**
     * Send email.
     */
    sendEmail(options: {
        to: string[];
        subject: string;
        body: string;
        importance?: 'low' | 'normal' | 'high';
    }): Promise<void>;
    /**
     * Reply to email.
     */
    replyToEmail(messageId: string, comment: string): Promise<void>;
    /**
     * Mark email as read.
     */
    markAsRead(messageId: string): Promise<void>;
    /**
     * Delete email.
     */
    deleteEmail(messageId: string): Promise<void>;
    /**
     * List calendar events.
     */
    listEvents(options?: {
        top?: number;
        filter?: string;
    }): Promise<GraphEvent[]>;
    /**
     * Create calendar event.
     */
    createEvent(options: {
        subject: string;
        start: string;
        end: string;
        body?: string;
        attendees?: string[];
        location?: string;
    }): Promise<GraphEvent>;
    /**
     * Delete calendar event.
     */
    deleteEvent(eventId: string): Promise<void>;
    /**
     * List OneDrive files.
     */
    listFiles(path?: string, top?: number): Promise<GraphFile[]>;
    /**
     * Upload file to OneDrive.
     */
    uploadFile(drivePath: string, content: string): Promise<GraphFile>;
    /**
     * Download file from OneDrive.
     */
    downloadFile(drivePath: string): Promise<string>;
    /**
     * Delete file from OneDrive.
     */
    deleteFile(drivePath: string): Promise<void>;
    /**
     * List contacts.
     */
    listContacts(top?: number): Promise<Array<{
        id: string;
        displayName: string;
        emailAddresses: Array<{
            address: string;
        }>;
    }>>;
}
export declare function getMicrosoftGraphClient(config?: GraphConfig): MicrosoftGraphClient;
export declare function resetMicrosoftGraphClient(): void;
//# sourceMappingURL=microsoft-graph.d.ts.map