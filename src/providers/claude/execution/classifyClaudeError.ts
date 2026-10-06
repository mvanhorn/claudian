import type { ProviderSessionInvalidation } from '../../../core/execution';
import { parseEnvironmentVariables } from '../../../core/process/env';
import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';

/** Variables Claude Code prefers over a Claude.ai subscription login, in hint order. */
const CLAUDE_INHERITED_AUTH_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export type ClaudeErrorCategory =
  | 'provider-session-missing'
  | 'authentication'
  | 'configuration'
  | 'transport'
  | 'process-exited'
  | 'provider';

export interface ClaudeErrorDetails {
  category: ClaudeErrorCategory;
  message: string;
  recoverable: boolean;
  missingProviderSessionId?: string;
}

/**
 * Typed signals win. Text matching is the fallback for plain `Error`s whose
 * only contract is their message: the SDK's ProcessTransport throws untyped
 * `Error`s ("Claude Code process exited with code N", "ProcessTransport is not
 * ready for writing"), CLI/Node resolution failures carry no code, and
 * `native_error` messages arrive re-wrapped without their origin.
 * The SDK `AbortError` is deliberately not checked: it sets no `name`, and a
 * value import would evaluate the lazily loaded SDK bundle at plugin startup.
 */
export function classifyClaudeError(
  error: unknown,
  expectedSessionId: string | null,
  explicitMissingSessionId?: string,
): ClaudeErrorDetails {
  const message = error instanceof Error
    ? error.message
    : String(error);
  if (
    explicitMissingSessionId
    || isSessionMissingError(error, expectedSessionId ?? undefined)
  ) {
    return {
      category: 'provider-session-missing',
      message,
      recoverable: true,
      missingProviderSessionId: explicitMissingSessionId
        ?? getMissingSessionId(error)
        ?? undefined,
    };
  }
  if (error instanceof ProviderModelUnavailableError) {
    return { category: 'configuration', message, recoverable: true };
  }
  if ((error as NodeJS.ErrnoException | null)?.code === 'EPIPE') {
    return { category: 'process-exited', message, recoverable: true };
  }
  return {
    category: classifyErrorText(message.toLowerCase()),
    message,
    recoverable: true,
  };
}

function getMissingSessionId(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  const match = message.match(/no conversation found with session id:\s*([a-z0-9_-]+)/i);
  return match?.[1] ?? null;
}

function isSessionMissingError(error: unknown, expectedSessionId?: string): boolean {
  const missingSessionId = getMissingSessionId(error);
  return !!missingSessionId
    && (!expectedSessionId || missingSessionId.toLowerCase() === expectedSessionId.toLowerCase());
}

function mentionsClaudeAuthentication(normalized: string): boolean {
  return normalized.includes('authentication')
    || normalized.includes('unauthorized')
    || normalized.includes('api key');
}

function classifyErrorText(normalized: string): ClaudeErrorCategory {
  if (mentionsClaudeAuthentication(normalized)) {
    return 'authentication';
  }
  if (
    normalized.includes('cli not found')
    || normalized.includes('node.js')
    || normalized.includes('could not determine')
  ) {
    return 'configuration';
  }
  if (
    normalized.includes('process exited')
    || normalized.includes('epipe')
  ) {
    return 'process-exited';
  }
  if (
    normalized.includes('transport')
    || normalized.includes('connection')
  ) {
    return 'transport';
  }
  return 'provider';
}

/**
 * Launch-environment auth variables the user did not assign in Claudian.
 * An empty custom assignment still counts as assigned, so it is omitted.
 */
export function inheritedClaudeAuthOverrides(
  launchEnv: Readonly<Record<string, string | undefined>> | undefined,
  configuredEnvText: string,
): string[] {
  const configuredKeys = new Set(
    Object.keys(parseEnvironmentVariables(configuredEnvText)).map(key => key.toLowerCase()),
  );
  return CLAUDE_INHERITED_AUTH_KEYS.filter(key =>
    !configuredKeys.has(key.toLowerCase())
    && hasNonEmptyLaunchValue(launchEnv, key));
}

function hasNonEmptyLaunchValue(
  launchEnv: Readonly<Record<string, string | undefined>> | undefined,
  key: string,
): boolean {
  if (!launchEnv) return false;
  const normalized = key.toLowerCase();
  return Object.entries(launchEnv).some(([name, value]) =>
    name.toLowerCase() === normalized && typeof value === 'string' && value.length > 0);
}

/** Appends an empty-assignment hint when inherited auth variables explain an authentication failure. */
export function appendInheritedClaudeAuthHint(message: string, keys: readonly string[]): string {
  if (keys.length === 0 || !mentionsClaudeAuthentication(message.toLowerCase())) return message;
  const listed = keys.length === 1
    ? keys[0]
    : keys.length === 2
      ? `${keys[0]} and ${keys[1]}`
      : `${keys.slice(0, -1).join(', ')}, and ${keys[keys.length - 1]}`;
  const verb = keys.length === 1 ? 'overrides' : 'override';
  return `${message}\n\nInherited ${listed} ${verb} the Claude subscription login, `
    + 'so set each one to empty under Settings → Providers → Claude → Custom variables, '
    + 'for example ANTHROPIC_API_KEY=.';
}

export function getClaudeInvalidationReason(
  category: ClaudeErrorCategory,
): ProviderSessionInvalidation['reason'] {
  switch (category) {
    case 'provider-session-missing':
      return 'provider-session-missing';
    case 'process-exited':
      return 'process-exited';
    case 'transport':
      return 'transport-closed';
    default:
      return 'provider-error';
  }
}
