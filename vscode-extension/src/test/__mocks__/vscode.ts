/**
 * Mock for the 'vscode' module used in unit tests.
 * Provides minimal implementations of VS Code APIs needed by the extension.
 */

// ─── Enums / Constants ──────────────────────────────────────────────────────

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum InlineCompletionTriggerKind {
  Automatic = 0,
  Explicit = 1,
}

// ─── Classes ────────────────────────────────────────────────────────────────

export class Disposable {
  dispose(): void { /* noop */ }
}

export class Position {
  line: number;
  character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }

  translate(lineDelta: number, charDelta: number): Position {
    return new Position(this.line + lineDelta, this.character + charDelta);
  }
}

export class Range {
  start: Position;
  end: Position;

  constructor(start: Position, end: Position) {
    this.start = start;
    this.end = end;
  }
}

export class Uri {
  fsPath: string;
  private _path: string;

  static file(path: string): Uri {
    const uri = new Uri();
    uri.fsPath = path;
    uri._path = path;
    return uri;
  }

  static parse(value: string): Uri {
    const uri = new Uri();
    uri._path = value;
    uri.fsPath = value.startsWith('file://') ? value.slice(7) : value;
    return uri;
  }

  static joinPath(base: Uri, ...paths: string[]): Uri {
    const joined = [base.fsPath, ...paths].join('/');
    return Uri.file(joined);
  }

  toString(): string {
    return this._path || this.fsPath;
  }
}

export class ThemeColor {
  id: string;
  constructor(id: string) { this.id = id; }
}

export class InlineCompletionItem {
  insertText: string;
  range: Range;

  constructor(text: string, range: Range) {
    this.insertText = text;
    this.range = range;
  }
}

// ─── Mock Objects ───────────────────────────────────────────────────────────

export class MockTextDocument {
  uri: Uri;
  fileName: string;
  languageId: string;
  private _lines: string[];
  lineCount: number;

  constructor(fileName: string, content: string = '', languageId: string = 'typescript') {
    this.uri = Uri.file(fileName);
    this.fileName = fileName;
    this.languageId = languageId;
    this._lines = content.split('\n');
    this.lineCount = this._lines.length;
  }

  lineAt(line: number): { text: string } {
    return { text: this._lines[line] || '' };
  }

  getText(range?: Range): string {
    if (!range) return this._lines.join('\n');
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

export class MockTextEditor {
  document: MockTextDocument;
  selection: Range;
  viewColumn?: ViewColumn;

  constructor(document: MockTextDocument, selection?: Range) {
    this.document = document;
    this.selection = selection || new Range(new Position(0, 0), new Position(0, 0));
  }
}

export class MockWebviewPanel {
  visible: boolean = true;
  webview = {
    html: '',
    postMessage: () => true,
    onDidReceiveMessage: () => new Disposable(),
  };
  onDidDispose: () => Disposable = () => new Disposable();
  reveal(): void { /* noop */ }
  dispose(): void { /* noop */ }
}

export class MockStatusBarItem {
  text: string = '';
  tooltip: string = '';
  command: string = '';
  backgroundColor?: ThemeColor;
  show(): void { /* noop */ }
  hide(): void { /* noop */ }
  dispose(): void { /* noop */ }
}

// ─── Workspace Configuration ────────────────────────────────────────────────

const configValues: Record<string, unknown> = {
  'agent-nuvira.cliPath': 'buff',
  'agent-nuvira.defaultProvider': '',
  'agent-nuvira.defaultModel': '',
  'agent-nuvira.autoApplyChanges': false,
  'agent-nuvira.maxTokens': 4096,
  'agent-nuvira.showProgressPanel': true,
};

export class MockWorkspaceConfiguration {
  private _values: Record<string, unknown>;

  constructor(values?: Record<string, unknown>) {
    this._values = { ...configValues, ...values };
  }

  get<T>(key: string, defaultValue?: T): T {
    return (this._values[key] as T) ?? defaultValue as T;
  }

  has(key: string): boolean {
    return key in this._values;
  }

  inspect<T>(key: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T } | undefined {
    if (!(key in this._values)) return undefined;
    return { key, defaultValue: this._values[key] as T };
  }
}

// ─── Windows / Dialogs ──────────────────────────────────────────────────────

let inputBoxResult: string | undefined;
let showQuickPickResult: unknown;
let showWarningMessageResult: unknown;

export function __setInputBoxResult(value: string | undefined): void {
  inputBoxResult = value;
}

export function __setQuickPickResult(value: unknown): void {
  showQuickPickResult = value;
}

export function __setShowWarningMessageResult(value: unknown): void {
  showWarningMessageResult = value;
}

export const window = {
  activeTextEditor: null as MockTextEditor | null,
  visibleTextEditors: [] as MockTextEditor[],

  showInputBox: (options?: { prompt?: string; placeHolder?: string; validateInput?: (v: string) => string | undefined }): Promise<string | undefined> => {
    const result = inputBoxResult;
    inputBoxResult = undefined;
    if (result !== undefined && options?.validateInput) {
      const validationError = options.validateInput(result);
      if (validationError) return Promise.resolve(undefined);
    }
    return Promise.resolve(result);
  },

  showQuickPick: <T>(items: T[], options?: { placeHolder?: string }): Promise<T | undefined> => {
    const result = showQuickPickResult as T | undefined;
    showQuickPickResult = undefined;
    return Promise.resolve(result);
  },

  showInformationMessage: (message: string): Thenable<string | undefined> => Promise.resolve(undefined),
  showWarningMessage: (message: string, ...items: string[]): Thenable<string | undefined> => {
    const result = showWarningMessageResult as string | undefined;
    showWarningMessageResult = undefined;
    return Promise.resolve(result);
  },
  showErrorMessage: (message: string): Thenable<string | undefined> => Promise.resolve(undefined),

  createWebviewPanel: (viewType: string, title: string, column: ViewColumn, options?: { enableScripts?: boolean }): MockWebviewPanel => {
    return new MockWebviewPanel();
  },

  createStatusBarItem: (alignment?: StatusBarAlignment, priority?: number): MockStatusBarItem => {
    return new MockStatusBarItem();
  },

  showTextDocument: (document: MockTextDocument, options?: { preview?: boolean; viewColumn?: ViewColumn }): Thenable<MockTextEditor> => {
    return Promise.resolve(new MockTextEditor(document));
  },
};

// ─── Commands ───────────────────────────────────────────────────────────────

const registeredCommands: Map<string, (...args: unknown[]) => unknown> = new Map();

// Wrap registerCommand as a mock function so tests can spy on it
import { vi } from 'vitest';

export const commands = {
  registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown): Disposable => {
    registeredCommands.set(id, handler);
    return new Disposable();
  }),

  executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
    const handler = registeredCommands.get(id);
    if (handler) return handler(...args);
    return undefined;
  },
};

// ─── Workspace ──────────────────────────────────────────────────────────────

let workspaceFolders: Array<{ uri: Uri; name: string; index: number }> = [];

export function __setWorkspaceFolders(folders: string[]): void {
  workspaceFolders = folders.map((path, i) => ({
    uri: Uri.file(path),
    name: path.split('/').pop() || 'workspace',
    index: i,
  }));
}

export function __resetWorkspaceFolders(): void {
  workspaceFolders = [];
}

export const workspace = {
  workspaceFolders: null as typeof workspaceFolders | null,
  asRelativePath: (pathOrUri: string | Uri): string => {
    const path = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
    // Simple mock: return basename
    return path.split('/').pop() || path;
  },

  getConfiguration: (section?: string): MockWorkspaceConfiguration => {
    return new MockWorkspaceConfiguration();
  },

  onDidChangeConfiguration: (handler: (e: { affectsConfiguration: (s: string) => boolean }) => void): Disposable => {
    return new Disposable();
  },

  onDidSaveTextDocument: (handler: (doc: { uri: Uri }) => void): Disposable => {
    return new Disposable();
  },

  openTextDocument: (options?: { content?: string; language?: string }): Thenable<MockTextDocument> => {
    return Promise.resolve(new MockTextDocument('untitled', options?.content || '', options?.language || 'plaintext'));
  },

  onDidChangeWorkspaceFolders: (handler: () => void): Disposable => {
    return new Disposable();
  },
};

// ─── Languages ──────────────────────────────────────────────────────────────

export const languages = {
  registerInlineCompletionItemProvider: (selector: unknown, provider: unknown): Disposable => {
    return new Disposable();
  },
};

// ─── Cancellation Token ─────────────────────────────────────────────────────

export class CancellationTokenSource {
  private _listeners: Array<() => void> = [];
  token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void): Disposable => {
      this._listeners.push(listener);
      return new Disposable();
    },
  };

  cancel(): void {
    (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    for (const listener of this._listeners) {
      listener();
    }
  }

  dispose(): void {
    this._listeners = [];
  }
}

// ─── Extension Context ──────────────────────────────────────────────────────

export class MockExtensionContext {
  subscriptions: Disposable[] = [];
  extensionUri = Uri.file('/test/extension');
  extensionPath = '/test/extension';
  globalStorageUri = Uri.file('/test/storage');
  globalState = { get: () => undefined, update: () => Promise.resolve() };
  workspaceState = { get: () => undefined, update: () => Promise.resolve() };
  extensionMode = 1;
}

// ─── InlineCompletionContext ────────────────────────────────────────────────

export const InlineCompletionContext = {
  triggerKind: InlineCompletionTriggerKind,
};

// ─── Reset helpers ──────────────────────────────────────────────────────────

export function __resetAllMocks(): void {
  inputBoxResult = undefined;
  showQuickPickResult = undefined;
  showWarningMessageResult = undefined;
  registeredCommands.clear();
  workspaceFolders = [];
  workspace.workspaceFolders = null;
  window.activeTextEditor = null;
  window.visibleTextEditors = [];
}

/**
 * Default export so `import * as vscode from 'vscode'` works.
 */
export default {
  Disposable,
  Position,
  Range,
  Uri,
  ThemeColor,
  InlineCompletionItem,
  StatusBarAlignment,
  ViewColumn,
  InlineCompletionTriggerKind,
  window,
  commands,
  workspace,
  languages,
  CancellationTokenSource,
  InlineCompletionContext,
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
