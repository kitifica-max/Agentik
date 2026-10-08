const SENSITIVE_PATTERNS = [
  /contraseña/i, /password/i, /\bpin\b/i, /\bcvv\b/i,
  /tarjeta\s*(de\s*)?(crédito|débito)/i, /credit\s*card/i,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /clave\s*(privada|secreta|api)/i, /api[_\s]?key/i, /secret[_\s]?key/i,
  /\bbanco\b/i, /\bbancari/i,
  /\bsalud\b/i, /\bmédic/i, /\bdiagnóstic/i,
  /ssh[_\s-]?key/i, /\.pem\b/i, /\.env\b/i,
  /bitwarden/i, /1password/i, /keychain/i, /\bwallet\b/i,
];

export function isSensitiveText(text: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(text));
}
