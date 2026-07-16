"use strict";
/**
 * Mock for the 'vscode' module used in unit tests.
 * Provides minimal implementations of VS Code APIs needed by the extension.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InlineCompletionContext = exports.MockExtensionContext = exports.CancellationTokenSource = exports.languages = exports.workspace = exports.commands = exports.window = exports.MockWorkspaceConfiguration = exports.MockStatusBarItem = exports.MockWebviewPanel = exports.MockTextEditor = exports.MockTextDocument = exports.InlineCompletionItem = exports.ThemeColor = exports.Uri = exports.Range = exports.Position = exports.Disposable = exports.InlineCompletionTriggerKind = exports.ViewColumn = exports.StatusBarAlignment = void 0;
exports.__setInputBoxResult = __setInputBoxResult;
exports.__setQuickPickResult = __setQuickPickResult;
exports.__setShowWarningMessageResult = __setShowWarningMessageResult;
exports.__setWorkspaceFolders = __setWorkspaceFolders;
exports.__resetWorkspaceFolders = __resetWorkspaceFolders;
exports.__resetAllMocks = __resetAllMocks;
// ─── Enums / Constants ──────────────────────────────────────────────────────
var StatusBarAlignment;
(function (StatusBarAlignment) {
    StatusBarAlignment[StatusBarAlignment["Left"] = 1] = "Left";
    StatusBarAlignment[StatusBarAlignment["Right"] = 2] = "Right";
})(StatusBarAlignment || (exports.StatusBarAlignment = StatusBarAlignment = {}));
var ViewColumn;
(function (ViewColumn) {
    ViewColumn[ViewColumn["Active"] = -1] = "Active";
    ViewColumn[ViewColumn["Beside"] = -2] = "Beside";
    ViewColumn[ViewColumn["One"] = 1] = "One";
    ViewColumn[ViewColumn["Two"] = 2] = "Two";
    ViewColumn[ViewColumn["Three"] = 3] = "Three";
})(ViewColumn || (exports.ViewColumn = ViewColumn = {}));
var InlineCompletionTriggerKind;
(function (InlineCompletionTriggerKind) {
    InlineCompletionTriggerKind[InlineCompletionTriggerKind["Automatic"] = 0] = "Automatic";
    InlineCompletionTriggerKind[InlineCompletionTriggerKind["Explicit"] = 1] = "Explicit";
})(InlineCompletionTriggerKind || (exports.InlineCompletionTriggerKind = InlineCompletionTriggerKind = {}));
// ─── Classes ────────────────────────────────────────────────────────────────
class Disposable {
    dispose() { }
}
exports.Disposable = Disposable;
class Position {
    line;
    character;
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
    translate(lineDelta, charDelta) {
        return new Position(this.line + lineDelta, this.character + charDelta);
    }
}
exports.Position = Position;
class Range {
    start;
    end;
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
}
exports.Range = Range;
class Uri {
    fsPath;
    _path;
    static file(path) {
        const uri = new Uri();
        uri.fsPath = path;
        uri._path = path;
        return uri;
    }
    static parse(value) {
        const uri = new Uri();
        uri._path = value;
        uri.fsPath = value.startsWith('file://') ? value.slice(7) : value;
        return uri;
    }
    static joinPath(base, ...paths) {
        const joined = [base.fsPath, ...paths].join('/');
        return Uri.file(joined);
    }
    toString() {
        return this._path || this.fsPath;
    }
}
exports.Uri = Uri;
class ThemeColor {
    id;
    constructor(id) { this.id = id; }
}
exports.ThemeColor = ThemeColor;
class InlineCompletionItem {
    insertText;
    range;
    constructor(text, range) {
        this.insertText = text;
        this.range = range;
    }
}
exports.InlineCompletionItem = InlineCompletionItem;
// ─── Mock Objects ───────────────────────────────────────────────────────────
class MockTextDocument {
    uri;
    fileName;
    languageId;
    _lines;
    lineCount;
    constructor(fileName, content = '', languageId = 'typescript') {
        this.uri = Uri.file(fileName);
        this.fileName = fileName;
        this.languageId = languageId;
        this._lines = content.split('\n');
        this.lineCount = this._lines.length;
    }
    lineAt(line) {
        return { text: this._lines[line] || '' };
    }
    getText(range) {
        if (!range)
            return this._lines.join('\n');
        if (range.start.line === range.end.line) {
            return this._lines[range.start.line]?.slice(range.start.character, range.end.character) || '';
        }
        const lines = this._lines.slice(range.start.line, range.end.line + 1);
        if (lines.length > 0) {
            lines[0] = lines[0].slice(range.start.character);
            lines[lines.length - 1] = lines[lines.length - 1].slice(0, range.end.character);
        }
        return lines.join('\n');
    }
}
exports.MockTextDocument = MockTextDocument;
class MockTextEditor {
    document;
    selection;
    viewColumn;
    constructor(document, selection) {
        this.document = document;
        this.selection = selection || new Range(new Position(0, 0), new Position(0, 0));
    }
}
exports.MockTextEditor = MockTextEditor;
class MockWebviewPanel {
    visible = true;
    webview = {
        html: '',
        postMessage: () => true,
        onDidReceiveMessage: () => new Disposable(),
    };
    onDidDispose = () => new Disposable();
    reveal() { }
    dispose() { }
}
exports.MockWebviewPanel = MockWebviewPanel;
class MockStatusBarItem {
    text = '';
    tooltip = '';
    command = '';
    backgroundColor;
    show() { }
    hide() { }
    dispose() { }
}
exports.MockStatusBarItem = MockStatusBarItem;
// ─── Workspace Configuration ────────────────────────────────────────────────
const configValues = {
    'agent-baba-d.cliPath': 'buff',
    'agent-baba-d.defaultProvider': '',
    'agent-baba-d.defaultModel': '',
    'agent-baba-d.autoApplyChanges': false,
    'agent-baba-d.maxTokens': 4096,
    'agent-baba-d.showProgressPanel': true,
};
class MockWorkspaceConfiguration {
    _values;
    constructor(values) {
        this._values = { ...configValues, ...values };
    }
    get(key, defaultValue) {
        return this._values[key] ?? defaultValue;
    }
    has(key) {
        return key in this._values;
    }
    inspect(key) {
        if (!(key in this._values))
            return undefined;
        return { key, defaultValue: this._values[key] };
    }
}
exports.MockWorkspaceConfiguration = MockWorkspaceConfiguration;
// ─── Windows / Dialogs ──────────────────────────────────────────────────────
let inputBoxResult;
let showQuickPickResult;
let showWarningMessageResult;
function __setInputBoxResult(value) {
    inputBoxResult = value;
}
function __setQuickPickResult(value) {
    showQuickPickResult = value;
}
function __setShowWarningMessageResult(value) {
    showWarningMessageResult = value;
}
exports.window = {
    activeTextEditor: null,
    visibleTextEditors: [],
    showInputBox: (options) => {
        const result = inputBoxResult;
        inputBoxResult = undefined;
        if (result !== undefined && options?.validateInput) {
            const validationError = options.validateInput(result);
            if (validationError)
                return Promise.resolve(undefined);
        }
        return Promise.resolve(result);
    },
    showQuickPick: (items, options) => {
        const result = showQuickPickResult;
        showQuickPickResult = undefined;
        return Promise.resolve(result);
    },
    showInformationMessage: (message) => Promise.resolve(undefined),
    showWarningMessage: (message, ...items) => {
        const result = showWarningMessageResult;
        showWarningMessageResult = undefined;
        return Promise.resolve(result);
    },
    showErrorMessage: (message) => Promise.resolve(undefined),
    createWebviewPanel: (viewType, title, column, options) => {
        return new MockWebviewPanel();
    },
    createStatusBarItem: (alignment, priority) => {
        return new MockStatusBarItem();
    },
    showTextDocument: (document, options) => {
        return Promise.resolve(new MockTextEditor(document));
    },
};
// ─── Commands ───────────────────────────────────────────────────────────────
const registeredCommands = new Map();
// Wrap registerCommand as a mock function so tests can spy on it
const vitest_1 = require("vitest");
exports.commands = {
    registerCommand: vitest_1.vi.fn((id, handler) => {
        registeredCommands.set(id, handler);
        return new Disposable();
    }),
    executeCommand: async (id, ...args) => {
        const handler = registeredCommands.get(id);
        if (handler)
            return handler(...args);
        return undefined;
    },
};
// ─── Workspace ──────────────────────────────────────────────────────────────
let workspaceFolders = [];
function __setWorkspaceFolders(folders) {
    workspaceFolders = folders.map((path, i) => ({
        uri: Uri.file(path),
        name: path.split('/').pop() || 'workspace',
        index: i,
    }));
}
function __resetWorkspaceFolders() {
    workspaceFolders = [];
}
exports.workspace = {
    workspaceFolders: null,
    asRelativePath: (pathOrUri) => {
        const path = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
        // Simple mock: return basename
        return path.split('/').pop() || path;
    },
    getConfiguration: (section) => {
        return new MockWorkspaceConfiguration();
    },
    onDidChangeConfiguration: (handler) => {
        return new Disposable();
    },
    onDidSaveTextDocument: (handler) => {
        return new Disposable();
    },
    openTextDocument: (options) => {
        return Promise.resolve(new MockTextDocument('untitled', options?.content || '', options?.language || 'plaintext'));
    },
    onDidChangeWorkspaceFolders: (handler) => {
        return new Disposable();
    },
};
// ─── Languages ──────────────────────────────────────────────────────────────
exports.languages = {
    registerInlineCompletionItemProvider: (selector, provider) => {
        return new Disposable();
    },
};
// ─── Cancellation Token ─────────────────────────────────────────────────────
class CancellationTokenSource {
    _listeners = [];
    token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
            this._listeners.push(listener);
            return new Disposable();
        },
    };
    cancel() {
        this.token.isCancellationRequested = true;
        for (const listener of this._listeners) {
            listener();
        }
    }
    dispose() {
        this._listeners = [];
    }
}
exports.CancellationTokenSource = CancellationTokenSource;
// ─── Extension Context ──────────────────────────────────────────────────────
class MockExtensionContext {
    subscriptions = [];
    extensionUri = Uri.file('/test/extension');
    extensionPath = '/test/extension';
    globalStorageUri = Uri.file('/test/storage');
    globalState = { get: () => undefined, update: () => Promise.resolve() };
    workspaceState = { get: () => undefined, update: () => Promise.resolve() };
    extensionMode = 1;
}
exports.MockExtensionContext = MockExtensionContext;
// ─── InlineCompletionContext ────────────────────────────────────────────────
exports.InlineCompletionContext = {
    triggerKind: InlineCompletionTriggerKind,
};
// ─── Reset helpers ──────────────────────────────────────────────────────────
function __resetAllMocks() {
    inputBoxResult = undefined;
    showQuickPickResult = undefined;
    showWarningMessageResult = undefined;
    registeredCommands.clear();
    workspaceFolders = [];
    exports.workspace.workspaceFolders = null;
    exports.window.activeTextEditor = null;
    exports.window.visibleTextEditors = [];
}
/**
 * Default export so `import * as vscode from 'vscode'` works.
 */
exports.default = {
    Disposable,
    Position,
    Range,
    Uri,
    ThemeColor,
    InlineCompletionItem,
    StatusBarAlignment,
    ViewColumn,
    InlineCompletionTriggerKind,
    window: exports.window,
    commands: exports.commands,
    workspace: exports.workspace,
    languages: exports.languages,
    CancellationTokenSource,
    InlineCompletionContext: exports.InlineCompletionContext,
    MockTextDocument,
    MockTextEditor,
    MockWebviewPanel,
    MockStatusBarItem,
    MockWorkspaceConfiguration,
    MockExtensionContext,
    __setInputBoxResult: __setInputBoxResult,
    __setQuickPickResult: __setQuickPickResult,
    __setShowWarningMessageResult: __setShowWarningMessageResult,
    __setWorkspaceFolders: __setWorkspaceFolders,
    __resetWorkspaceFolders: __resetWorkspaceFolders,
    __resetAllMocks,
};
//# sourceMappingURL=vscode.js.map