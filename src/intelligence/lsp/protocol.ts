/** JSON-RPC 2.0 message types */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** LSP position/location types */
export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }
export interface Location { uri: string; range: Range; }

/** LSP document symbol */
export interface DocumentSymbol {
  name: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export enum SymbolKind {
  File = 1, Module = 2, Namespace = 3, Package = 4, Class = 5,
  Method = 6, Property = 7, Field = 8, Constructor = 9, Enum = 10,
  Interface = 11, Function = 12, Variable = 13, Constant = 14,
  String = 15, Number = 16, Boolean = 17, Array = 18, Object = 19,
  Key = 20, Null = 21, EnumMember = 22, Struct = 23, Event = 24,
  Operator = 25, TypeParameter = 26
}

/** LSP diagnostic */
export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;  // Error, Warning, Info, Hint
  message: string;
  source?: string;
}

/** LSP hover result */
export interface Hover {
  contents: string | { kind: string; value: string };
  range?: Range;
}

/** LSP initialize params (minimal) */
export interface InitializeParams {
  processId: number;
  rootUri: string;
  capabilities: Record<string, unknown>;
}

/** LSP text document identifier */
export interface TextDocumentIdentifier { uri: string; }
export interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}
