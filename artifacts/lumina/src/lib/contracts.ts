declare const __contractAddressBrand: unique symbol;

export type ContractAddress = string & { readonly [__contractAddressBrand]: true };

const isSandbox = import.meta.env.VITE_PI_SANDBOX === "true";

const TESTNET_CONTRACTS = Object.freeze({
  VAULT:   "CCLYJ3RFCUQXMK5YWWZHGNQXPJ2JAXB4NVQE6KTPHDZG7MZS2K4BXIUZ" as ContractAddress,
  STAKING: "CDMPKQVB5RJFU6HTE2WLGXZ4NYJ7QCAM3PVIQKTSF4GWD2ABXE6RCNYZ" as ContractAddress,
  BORROW:  "CENPX4SVHD7AKQYJZFBX2WMNGJLCR5TPUVXEKH6YIQDWZ3MBAS7FNGLA" as ContractAddress,
  BRIDGE:  "CFMXB3RWPVLHAGQ6K5JYCTNXH4EPWDUZV7A2EMGS3IQBN6JKRT4DXYZC" as ContractAddress,
} as const);

const MAINNET_CONTRACTS = Object.freeze({
  VAULT:   "CBJKM5WQZRH6ADYVF2PXNEL3TQUCGSJW4BKMR7VHYZI5DPFAX6BNQLET" as ContractAddress,
  STAKING: "CGVNQJ5WXRAMPHTK3ZDBLEF7UWYS6CQPIXDJ4NVZGE2KBMHF3ARTYWGJ" as ContractAddress,
  BORROW:  "CHNWDY4JRZF5MSBKAEXGPQCL7V6UINKT2AVZEJXQ3PWHMF5GBLYT4RCG" as ContractAddress,
  BRIDGE:  "CJXVEFMNS3KAPTUWIDQBZGY7H4RCXJVP5DL6ENAT2MKWBFHQ7ZCLY3RX" as ContractAddress,
} as const);

export const LUMINA_CONTRACTS = isSandbox ? TESTNET_CONTRACTS : MAINNET_CONTRACTS;

export const PI_NETWORK_CONFIG = Object.freeze({
  horizonUrl:  isSandbox
    ? "https://api.testnet.minepi.com"
    : "https://api.mainnet.minepi.com",
  sorobanRpcUrl: isSandbox
    ? "https://soroban-rpc.testnet.minepi.com"
    : "https://soroban-rpc.mainnet.minepi.com",
  networkPassphrase: isSandbox
    ? "Pi Testnet ; December 2019"
    : "Pi Network ; May 2021",
  isSandbox,
});

export function isContractAddress(value: string): value is ContractAddress {
  return Object.values(LUMINA_CONTRACTS).includes(value as ContractAddress);
}
