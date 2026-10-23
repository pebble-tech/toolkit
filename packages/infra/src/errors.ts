/** Every refusal in this package is a GuardrailError subclass, so a caller can tell a guardrail from a bug. */
export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The stack name or product id is not one this package accepts. */
export class StageError extends GuardrailError {}

/** A component was asked to name or bind something outside its `<product>-<env>` namespace. */
export class NamespaceError extends GuardrailError {}

/** The database name is not a plain lowercase Postgres identifier. */
export class DatabaseNameError extends GuardrailError {}

/** An HTTP API was requested without a custom domain. */
export class MissingDomainError extends GuardrailError {}

/** An IAM role would be created without a permissions boundary. */
export class PermissionsBoundaryError extends GuardrailError {}

/** A value whose name says it is a secret was passed as plain text. */
export class PlainTextSecretError extends GuardrailError {}

/** A component was used in a stack that does not own what it creates. */
export class OwnershipError extends GuardrailError {}
