export interface LspCapabilities {
  documentSymbols: boolean;
  definition: boolean;
  references: boolean;
  hover: boolean;
  rename: boolean;
  diagnostics: boolean;
}

/**
 * Parse server capabilities from an initialize response result.
 * Returns a capabilities object with boolean flags for each feature.
 */
export function parseCapabilities(initResult: unknown): LspCapabilities {
  const caps: LspCapabilities = {
    documentSymbols: false,
    definition: false,
    references: false,
    hover: false,
    rename: false,
    diagnostics: false,
  };

  if (typeof initResult !== 'object' || initResult === null) return caps;

  const result = initResult as Record<string, unknown>;
  const serverCaps = result.capabilities;

  if (typeof serverCaps !== 'object' || serverCaps === null) return caps;

  const sc = serverCaps as Record<string, unknown>;

  // documentSymbolProvider can be a boolean or a DocumentSymbolOptions object
  if (sc.documentSymbolProvider === true ||
      (typeof sc.documentSymbolProvider === 'object' && sc.documentSymbolProvider !== null)) {
    caps.documentSymbols = true;
  }

  // definitionProvider
  if (sc.definitionProvider === true ||
      (typeof sc.definitionProvider === 'object' && sc.definitionProvider !== null)) {
    caps.definition = true;
  }

  // referencesProvider
  if (sc.referencesProvider === true ||
      (typeof sc.referencesProvider === 'object' && sc.referencesProvider !== null)) {
    caps.references = true;
  }

  // hoverProvider
  if (sc.hoverProvider === true ||
      (typeof sc.hoverProvider === 'object' && sc.hoverProvider !== null)) {
    caps.hover = true;
  }

  // renameProvider
  if (sc.renameProvider === true ||
      (typeof sc.renameProvider === 'object' && sc.renameProvider !== null)) {
    caps.rename = true;
  }

  // diagnostics: signalled by publishDiagnosticsProvider or textDocumentSync presence
  if (sc.publishDiagnosticsProvider !== undefined ||
      sc.diagnosticProvider !== undefined) {
    caps.diagnostics = true;
  }

  return caps;
}

/**
 * Check if a specific feature is available.
 */
export function hasCapability(
  capabilities: LspCapabilities,
  feature: keyof LspCapabilities,
): boolean {
  return capabilities[feature];
}
