/** Business-rule violation. `code` is the machine code, `message` is Korean and user-facing. */
export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, messageKo: string) {
    super(messageKo);
    this.name = 'EngineError';
    this.code = code;
  }
}
