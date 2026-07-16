/**
 * Mock for the 'vscode' module used in unit tests.
 * Provides minimal implementations of VS Code APIs needed by the extension.
 */
export declare enum StatusBarAlignment {
    Left = 1,
    Right = 2
}
export declare enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
    Three = 3
}
export declare enum InlineCompletionTriggerKind {
    Automatic = 0,
    Explicit = 1
}
export declare class Disposable {
    dispose(): void;
}
export declare class Position {
    line: number;
    character: number;
    constructor(line: number, character: number);
    translate(lineDelta: number, charDelta: number): Position;
}
export declare class Range {
    start: Position;
    end: Position;
    constructor(start: Position, end: Position);
}
export declare class Uri {
    fsPath: string;
    private _path;
    static file(path: string): Uri;
    static parse(value: string): Uri;
    static joinPath(base: Uri, ...paths: string[]): Uri;
    toString(): string;
}
export declare class ThemeColor {
    id: string;
    constructor(id: string);
}
export declare class InlineCompletionItem {
    insertText: string;
    range: Range;
    constructor(text: string, range: Range);
}
export declare class MockTextDocument {
    uri: Uri;
    fileName: string;
    languageId: string;
    private _lines;
    lineCount: number;
    constructor(fileName: string, content?: string, languageId?: string);
    lineAt(line: number): {
        text: string;
    };
    getText(range?: Range): string;
}
export declare class MockTextEditor {
    document: MockTextDocument;
    selection: Range;
    viewColumn?: ViewColumn;
    constructor(document: MockTextDocument, selection?: Range);
}
export declare class MockWebviewPanel {
    visible: boolean;
    webview: {
        html: string;
        postMessage: () => boolean;
        onDidReceiveMessage: () => Disposable;
    };
    onDidDispose: () => Disposable;
    reveal(): void;
    dispose(): void;
}
export declare class MockStatusBarItem {
    text: string;
    tooltip: string;
    command: string;
    backgroundColor?: ThemeColor;
    show(): void;
    hide(): void;
    dispose(): void;
}
export declare class MockWorkspaceConfiguration {
    private _values;
    constructor(values?: Record<string, unknown>);
    get<T>(key: string, defaultValue?: T): T;
    has(key: string): boolean;
    inspect<T>(key: string): {
        key: string;
        defaultValue?: T;
        globalValue?: T;
        workspaceValue?: T;
    } | undefined;
}
export declare function __setInputBoxResult(value: string | undefined): void;
export declare function __setQuickPickResult(value: unknown): void;
export declare function __setShowWarningMessageResult(value: unknown): void;
export declare const window: {
    activeTextEditor: MockTextEditor | null;
    visibleTextEditors: MockTextEditor[];
    showInputBox: (options?: {
        prompt?: string;
        placeHolder?: string;
        validateInput?: (v: string) => string | undefined;
    }) => Promise<string | undefined>;
    showQuickPick: <T>(items: T[], options?: {
        placeHolder?: string;
    }) => Promise<T | undefined>;
    showInformationMessage: (message: string) => Thenable<string | undefined>;
    showWarningMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
    showErrorMessage: (message: string) => Thenable<string | undefined>;
    createWebviewPanel: (viewType: string, title: string, column: ViewColumn, options?: {
        enableScripts?: boolean;
    }) => MockWebviewPanel;
    createStatusBarItem: (alignment?: StatusBarAlignment, priority?: number) => MockStatusBarItem;
    showTextDocument: (document: MockTextDocument, options?: {
        preview?: boolean;
        viewColumn?: ViewColumn;
    }) => Thenable<MockTextEditor>;
};
export declare const commands: {
    registerCommand: import("vitest").Mock<(id: string, handler: (...args: unknown[]) => unknown) => Disposable>;
    executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>;
};
declare let workspaceFolders: Array<{
    uri: Uri;
    name: string;
    index: number;
}>;
export declare function __setWorkspaceFolders(folders: string[]): void;
export declare function __resetWorkspaceFolders(): void;
export declare const workspace: {
    workspaceFolders: typeof workspaceFolders | null;
    asRelativePath: (pathOrUri: string | Uri) => string;
    getConfiguration: (section?: string) => MockWorkspaceConfiguration;
    onDidChangeConfiguration: (handler: (e: {
        affectsConfiguration: (s: string) => boolean;
    }) => void) => Disposable;
    onDidSaveTextDocument: (handler: (doc: {
        uri: Uri;
    }) => void) => Disposable;
    openTextDocument: (options?: {
        content?: string;
        language?: string;
    }) => Thenable<MockTextDocument>;
    onDidChangeWorkspaceFolders: (handler: () => void) => Disposable;
};
export declare const languages: {
    registerInlineCompletionItemProvider: (selector: unknown, provider: unknown) => Disposable;
};
export declare class CancellationTokenSource {
    private _listeners;
    token: {
        isCancellationRequested: boolean;
        onCancellationRequested: (listener: () => void) => Disposable;
    };
    cancel(): void;
    dispose(): void;
}
export declare class MockExtensionContext {
    subscriptions: Disposable[];
    extensionUri: Uri;
    extensionPath: string;
    globalStorageUri: Uri;
    globalState: {
        get: () => undefined;
        update: () => Promise<void>;
    };
    workspaceState: {
        get: () => undefined;
        update: () => Promise<void>;
    };
    extensionMode: number;
}
export declare const InlineCompletionContext: {
    triggerKind: typeof InlineCompletionTriggerKind;
};
export declare function __resetAllMocks(): void;
/**
 * Default export so `import * as vscode from 'vscode'` works.
 */
declare const _default: {
    Disposable: typeof Disposable;
    Position: typeof Position;
    Range: typeof Range;
    Uri: typeof Uri;
    ThemeColor: typeof ThemeColor;
    InlineCompletionItem: typeof InlineCompletionItem;
    StatusBarAlignment: typeof StatusBarAlignment;
    ViewColumn: typeof ViewColumn;
    InlineCompletionTriggerKind: typeof InlineCompletionTriggerKind;
    window: {
        activeTextEditor: MockTextEditor | null;
        visibleTextEditors: MockTextEditor[];
        showInputBox: (options?: {
            prompt?: string;
            placeHolder?: string;
            validateInput?: (v: string) => string | undefined;
        }) => Promise<string | undefined>;
        showQuickPick: <T>(items: T[], options?: {
            placeHolder?: string;
        }) => Promise<T | undefined>;
        showInformationMessage: (message: string) => Thenable<string | undefined>;
        showWarningMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
        showErrorMessage: (message: string) => Thenable<string | undefined>;
        createWebviewPanel: (viewType: string, title: string, column: ViewColumn, options?: {
            enableScripts?: boolean;
        }) => MockWebviewPanel;
        createStatusBarItem: (alignment?: StatusBarAlignment, priority?: number) => MockStatusBarItem;
        showTextDocument: (document: MockTextDocument, options?: {
            preview?: boolean;
            viewColumn?: ViewColumn;
        }) => Thenable<MockTextEditor>;
    };
    commands: {
        registerCommand: import("vitest").Mock<(id: string, handler: (...args: unknown[]) => unknown) => Disposable>;
        executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    workspace: {
        workspaceFolders: typeof workspaceFolders | null;
        asRelativePath: (pathOrUri: string | Uri) => string;
        getConfiguration: (section?: string) => MockWorkspaceConfiguration;
        onDidChangeConfiguration: (handler: (e: {
            affectsConfiguration: (s: string) => boolean;
        }) => void) => Disposable;
        onDidSaveTextDocument: (handler: (doc: {
            uri: Uri;
        }) => void) => Disposable;
        openTextDocument: (options?: {
            content?: string;
            language?: string;
        }) => Thenable<MockTextDocument>;
        onDidChangeWorkspaceFolders: (handler: () => void) => Disposable;
    };
    languages: {
        registerInlineCompletionItemProvider: (selector: unknown, provider: unknown) => Disposable;
    };
    CancellationTokenSource: typeof CancellationTokenSource;
    InlineCompletionContext: {
        triggerKind: typeof InlineCompletionTriggerKind;
    };
    MockTextDocument: typeof MockTextDocument;
    MockTextEditor: typeof MockTextEditor;
    MockWebviewPanel: typeof MockWebviewPanel;
    MockStatusBarItem: typeof MockStatusBarItem;
    MockWorkspaceConfiguration: typeof MockWorkspaceConfiguration;
    MockExtensionContext: typeof MockExtensionContext;
    __setInputBoxResult: typeof __setInputBoxResult;
    __setQuickPickResult: typeof __setQuickPickResult;
    __setShowWarningMessageResult: typeof __setShowWarningMessageResult;
    __setWorkspaceFolders: typeof __setWorkspaceFolders;
    __resetWorkspaceFolders: typeof __resetWorkspaceFolders;
    __resetAllMocks: typeof __resetAllMocks;
};
export default _default;
//# sourceMappingURL=vscode.d.ts.map