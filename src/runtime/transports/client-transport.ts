export interface ClientTransport<TKind extends string, TOperator, TPeer> {
  readonly kind: TKind;
  readonly operator: TOperator;
  readonly peer: TPeer;
  getOperatorClient(): TOperator;
  getPeerClient(): TPeer;
}

export function createClientTransport<TKind extends string, TOperator, TPeer>(
  kind: TKind,
  operator: TOperator,
  peer: TPeer,
): ClientTransport<TKind, TOperator, TPeer> {
  return Object.freeze({
    kind,
    operator,
    peer,
    getOperatorClient(): TOperator {
      return operator;
    },
    getPeerClient(): TPeer {
      return peer;
    },
  });
}
