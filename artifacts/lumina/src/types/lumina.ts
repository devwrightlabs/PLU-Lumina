export type PiConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

export interface PiUser {
  uid: string;
  username: string;
}

export interface PiSession {
  status: PiConnectionStatus;
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

export type CrossChainID = "ETH" | "BSC" | "MATIC";

export type CrossChainAsset = "ETH" | "BTC" | "USDT";

export type CrossChainDepositStatus =
  | "pending"
  | "detected"
  | "confirmed"
  | "minting"
  | "minted"
  | "failed"
  | "expired";

export interface DepositAddressResponse {
  depositId: string;
  depositAddress: string;
  chain: CrossChainID;
  asset: CrossChainAsset;
  wrappedAsset: string;
  expiresAt: number;
  status: CrossChainDepositStatus;
  minConfirmations: number;
}

export interface DepositStatusResponse {
  depositId: string;
  status: CrossChainDepositStatus;
  chain: CrossChainID;
  asset: CrossChainAsset;
  depositAddress: string;
  actualAmount?: string;
  confirmations?: number;
  externalTxHash?: string;
  sorobanTxHash?: string;
  failureReason?: string;
  updatedAt: number;
}

export interface CrossChainDepositState {
  depositId: string;
  chain: CrossChainID;
  asset: CrossChainAsset;
  depositAddress: string;
  wrappedAsset: string;
  status: CrossChainDepositStatus;
  confirmations: number;
  minConfirmations: number;
  externalTxHash: string | null;
  sorobanTxHash: string | null;
  failureReason: string | null;
  updatedAt: string;
}
