declare const __contractAddressBrand: unique symbol;

export type ContractAddress = string & { readonly [__contractAddressBrand]: true };

const LUMINA_CONTRACTS = Object.freeze({
  VAULT:   "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVAULT" as ContractAddress,
  STAKING: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASTAKE" as ContractAddress,
  BORROW:  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABORROW" as ContractAddress,
  BRIDGE:  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABRIDGE" as ContractAddress,
} as const);

export { LUMINA_CONTRACTS };

export function isContractAddress(value: string): value is ContractAddress {
  return Object.values(LUMINA_CONTRACTS).includes(value as ContractAddress);
}
