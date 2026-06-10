export {};

declare global {
  interface Window {
    Pi: PiSDK;
  }

  interface PiSDK {
    init(config: PiInitConfig): void;
    authenticate(
      scopes: PiScope[],
      onIncompletePaymentFound: (payment: PiPaymentDTO) => void,
    ): Promise<PiAuthResult>;
    createPayment(
      paymentData: PiPaymentData,
      callbacks: PiPaymentCallbacks,
    ): void;
  }

  interface PiInitConfig {
    version: string;
    sandbox?: boolean;
  }

  type PiScope = "username" | "payments" | "wallet_address";

  interface PiAuthResult {
    user: {
      uid: string;
      username: string;
      wallet_address?: string;
    };
    accessToken: string;
  }

  interface PiPaymentData {
    amount: number;
    memo: string;
    metadata: Record<string, unknown>;
  }

  interface PiPaymentDTO {
    identifier: string;
    user_uid: string;
    amount: number;
    memo: string;
    metadata: Record<string, unknown>;
    from_address: string;
    to_address: string;
    direction: "user_to_app" | "app_to_user";
    created_at: string;
    network: string;
    status: {
      developer_approved: boolean;
      transaction_verified: boolean;
      developer_completed: boolean;
      cancelled: boolean;
      user_cancelled: boolean;
    };
    transaction: {
      txid: string;
      verified: boolean;
      _link: string;
    } | null;
  }

  interface PiPaymentCallbacks {
    onReadyForServerApproval: (paymentId: string) => void;
    onReadyForServerCompletion: (paymentId: string, txid: string) => void;
    onCancel: (paymentId: string) => void;
    onError: (error: Error, payment?: PiPaymentDTO) => void;
  }
}
