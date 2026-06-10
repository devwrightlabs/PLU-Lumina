const isSandbox = process.env["LUMINA_SANDBOX"] === "true";

export const NETWORK_CONFIG = Object.freeze({
  isSandbox,
  horizonUrl: process.env["PI_HORIZON_URL"] ?? (
    isSandbox
      ? "https://api.testnet.minepi.com"
      : "https://api.mainnet.minepi.com"
  ),
  sorobanRpcUrl: process.env["PI_SOROBAN_RPC_URL"] ?? (
    isSandbox
      ? "https://soroban-rpc.testnet.minepi.com"
      : "https://soroban-rpc.mainnet.minepi.com"
  ),
  networkPassphrase: process.env["PI_NETWORK_PASSPHRASE"] ?? (
    isSandbox
      ? "Pi Testnet ; December 2019"
      : "Pi Network ; May 2021"
  ),
  vaultContract: process.env["PI_VAULT_CONTRACT"] ?? (
    isSandbox
      ? "CCLYJ3RFCUQXMK5YWWZHGNQXPJ2JAXB4NVQE6KTPHDZG7MZS2K4BXIUZ"
      : "CBJKM5WQZRH6ADYVF2PXNEL3TQUCGSJW4BKMR7VHYZI5DPFAX6BNQLET"
  ),
  vaultDepositFunction: "deposit",
});
