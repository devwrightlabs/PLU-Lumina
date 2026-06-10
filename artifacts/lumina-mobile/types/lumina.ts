export type PiSessionStatus = "idle" | "connecting" | "connected" | "error";

export interface PiUser {
  uid: string;
  username: string;
}

export interface PiSession {
  status: PiSessionStatus;
  user: PiUser | null;
  luminaJwt: string | null;
}

export type MultiSigTxStatus =
  | "pending_owner"
  | "pending_agent"
  | "broadcasting"
  | "confirmed"
  | "failed";

export interface MultiSigTransaction {
  txId: string;
  status: MultiSigTxStatus;
  updatedAt: string;
  xdrEnvelope: string | null;
}

export interface OmnichainBalances {
  pi: string;
  piBTC: string;
  piETH: string;
  piUSDT: string;
}

export type CrossChainAsset = "ETH" | "BTC" | "USDT";
export type CrossChainID = "ETH" | "BTC";
export type DepositStatus =
  | "pending"
  | "detected"
  | "confirmed"
  | "minting"
  | "minted"
  | "failed"
  | "expired";

export interface CrossChainDepositState {
  depositId: string;
  chain: CrossChainID;
  asset: CrossChainAsset;
  depositAddress: string;
  wrappedAsset: string;
  status: DepositStatus;
  confirmations: number;
  minConfirmations: number;
  externalTxHash: string | null;
  sorobanTxHash: string | null;
  failureReason: string | null;
  updatedAt: string;
}

export type NetworkChain = "Pi Network" | "Bitcoin Bridge" | "Ethereum Bridge" | "Soroban RPC";
export type NetworkStatus = "active" | "pending" | "offline";

export interface NetworkListener {
  chain: NetworkChain;
  status: NetworkStatus;
}
