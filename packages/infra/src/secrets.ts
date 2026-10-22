import { PlainTextSecretError } from './errors.js';

/** Names that hold credentials. base-app shipped DATABASE_URL and BETTER_AUTH_SECRET to its Worker as plain text. */
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_KEY|_KEY$|^KEY$|DATABASE_URL)/i;

/**
 * Throws PlainTextSecretError for a plain-text var whose name says it is a secret, unless the caller marked the
 * name as not secret in `plainTextAllowed`. Secrets go in the component's `secrets` map instead.
 */
export function assertNoSecretsInPlainText(
  component: string,
  vars: Record<string, unknown>,
  plainTextAllowed: readonly string[] = []
): void {
  const offending = Object.keys(vars).filter((key) => SECRET_NAME.test(key) && !plainTextAllowed.includes(key));
  if (offending.length > 0) {
    throw new PlainTextSecretError(
      `${component}: ${offending.join(', ')} look like secrets; pass them in \`secrets\`, or list them in \`plainTextAllowed\``
    );
  }
}
