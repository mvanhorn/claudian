import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import {
  appendInheritedClaudeAuthHint,
  classifyClaudeError,
  getClaudeInvalidationReason,
  inheritedClaudeAuthOverrides,
} from '@/providers/claude/execution/classifyClaudeError';

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('classifyClaudeError', () => {
  it.each([
    ['a missing expected session', new Error('No conversation found with session ID: abc-1'), 'provider-session-missing'],
    ['a missing session other than the expected one', new Error('No conversation found with session ID: other'), 'provider'],
    ['generic session-not-found wording', new Error('Session not found'), 'provider'],
    ['missing-conversation wording without a session id', new Error('No conversation found'), 'provider'],
    ['an unavailable model', new ProviderModelUnavailableError('Claude Code'), 'configuration'],
    ['an unresolved CLI', new Error('Claude Code CLI not found'), 'configuration'],
    ['an authentication failure', new Error('Invalid API key provided'), 'authentication'],
    ['an SDK process exit', new Error('Claude Code process exited with code 1'), 'process-exited'],
    ['a broken stdin pipe', errnoError('EPIPE', 'write failed'), 'process-exited'],
    ['an SDK transport write before readiness', new Error('ProcessTransport is not ready for writing'), 'transport'],
    ['an unrecognized failure', new Error('Something else'), 'provider'],
    ['a non-Error value', 'plain failure', 'provider'],
  ] as const)('classifies %s', (_label, error, category) => {
    expect(classifyClaudeError(error, 'abc-1')).toMatchObject({ category, recoverable: true });
  });

  it('reports the missing session from the message when no session is expected', () => {
    expect(classifyClaudeError(
      new Error('No conversation found with session ID: session-123'),
      null,
    )).toMatchObject({
      category: 'provider-session-missing',
      missingProviderSessionId: 'session-123',
    });
  });

  it('reports the explicit missing session over message evidence', () => {
    expect(classifyClaudeError(new Error('Session gone'), 'abc-1', 'abc-2')).toEqual({
      category: 'provider-session-missing',
      message: 'Session gone',
      recoverable: true,
      missingProviderSessionId: 'abc-2',
    });
  });

  it.each([
    ['provider-session-missing', 'provider-session-missing'],
    ['process-exited', 'process-exited'],
    ['transport', 'transport-closed'],
    ['authentication', 'provider-error'],
    ['provider', 'provider-error'],
  ] as const)('maps %s to the %s invalidation', (category, reason) => {
    expect(getClaudeInvalidationReason(category)).toBe(reason);
  });
});

describe('inherited Claude auth hints', () => {
  const authenticationMessage = 'Error: authentication_failed';
  const inheritedKey = { ANTHROPIC_API_KEY: 'stale' };

  it('names an inherited API key on authentication_failed', () => {
    const hinted = appendInheritedClaudeAuthHint(
      authenticationMessage,
      inheritedClaudeAuthOverrides(inheritedKey, ''),
    );
    expect(hinted).toContain('ANTHROPIC_API_KEY');
    expect(hinted).toContain('ANTHROPIC_API_KEY=');
    expect(hinted).not.toContain('stale');
  });

  it.each([
    'ANTHROPIC_API_KEY=configured-key',
    'ANTHROPIC_API_KEY=',
  ])('leaves the authentication message unchanged for configured %s', (configured) => {
    expect(appendInheritedClaudeAuthHint(
      authenticationMessage,
      inheritedClaudeAuthOverrides(inheritedKey, configured),
    )).toBe(authenticationMessage);
  });

  it('names an inherited base URL and oauth token in constant order', () => {
    const hinted = appendInheritedClaudeAuthHint(
      authenticationMessage,
      inheritedClaudeAuthOverrides({
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
        ANTHROPIC_BASE_URL: 'https://gateway.example',
      }, ''),
    );
    const baseUrl = hinted.indexOf('ANTHROPIC_BASE_URL');
    const oauthToken = hinted.indexOf('CLAUDE_CODE_OAUTH_TOKEN');
    expect(baseUrl).toBeGreaterThan(authenticationMessage.length);
    expect(oauthToken).toBeGreaterThan(baseUrl);
    expect(hinted).not.toContain('oauth-token');
    expect(hinted).not.toContain('gateway.example');
  });

  it('treats a lowercase launch key as the canonical name and ignores empty or missing values', () => {
    expect(inheritedClaudeAuthOverrides({ anthropic_api_key: 'stale' }, '')).toEqual([
      'ANTHROPIC_API_KEY',
    ]);
    expect(inheritedClaudeAuthOverrides({ ANTHROPIC_API_KEY: '' }, '')).toEqual([]);
    expect(inheritedClaudeAuthOverrides({}, '')).toEqual([]);
  });

  it('returns a rate-limit message unchanged when inherited keys are present', () => {
    const message = 'rate limit exceeded';
    expect(appendInheritedClaudeAuthHint(
      message,
      inheritedClaudeAuthOverrides(inheritedKey, ''),
    )).toBe(message);
  });
});
