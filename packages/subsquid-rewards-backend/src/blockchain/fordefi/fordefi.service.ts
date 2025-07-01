import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Hex } from 'viem';
import * as crypto from 'crypto';
import * as fs from 'fs';

export interface FordefiTransactionRequest {
  signer_type: string;
  type: string;
  details: {
    type: string;
    to: string;
    value: string;
    gas: {
      type: string;
      priority_level: string;
    };
    fail_on_prediction_failure: boolean;
    chain: string;
    data: {
      type: string;
      hex_data: string;
    };
  };
  note: string;
  vault_id: string;
}

export interface FordefiTransactionStatus {
  id: string;
  hash?: Hex;
  mined_result?: {
    reversion?: {
      state: string;
      reason?: string;
    };
  };
}

@Injectable()
export class FordefiService {
  private readonly logger = new Logger(FordefiService.name);
  private readonly gatewayHost = 'api.fordefi.com';
  private readonly maxTimeout = 30000; // 30 seconds
  private readonly initialTimeout = 250; // 250ms

  constructor(private configService: ConfigService) {}

  /**
   * get the vault address from Fordefi API
   */
  async getVaultAddress(): Promise<Hex> {
    const vaultId = this.configService.get('fordefi.vaultId');
    if (!vaultId) {
      throw new Error('FORDEFI_VAULT_ID is not configured');
    }

    const accessToken = this.configService.get('fordefi.accessToken');
    if (!accessToken) {
      throw new Error('FORDEFI_ACCESS_TOKEN is not configured');
    }

    try {
      const response = await fetch(
        `https://${this.gatewayHost}/api/v1/vaults/${vaultId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      return data.address as Hex;
    } catch (error) {
      this.logger.error(`Failed to get vault address: ${error.message}`);
      throw error;
    }
  }

  /**
   * send a transaction through Fordefi
   */
  async sendTransaction(
    to: string,
    data: string,
    name: string,
    gasOptions?: {
      type?: string;
      priority_level?: string;
    },
  ): Promise<Hex> {
    const request = this.createTransactionRequest(to, data, name, gasOptions);

    try {
      this.logger.log(`Sending Fordefi transaction: ${name}`);
      const transactionId = await this.submitTransaction(request);

      this.logger.log(`Transaction submitted with ID: ${transactionId}`);
      const txHash = await this.waitForTransaction(transactionId);

      this.logger.log(`Transaction completed: ${txHash}`);
      return txHash;
    } catch (error) {
      this.logger.error(`Fordefi transaction failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * create a Fordefi transaction request
   */
  private createTransactionRequest(
    to: string,
    data: string,
    name: string,
    gasOptions?: {
      type?: string;
      priority_level?: string;
    },
  ): FordefiTransactionRequest {
    const networkName = this.configService.get(
      'blockchain.network.networkName',
    );
    const chain =
      networkName === 'sepolia' ? 'arbitrum_sepolia' : 'arbitrum_mainnet';

    const vaultId = this.configService.get('fordefi.vaultId');
    if (!vaultId) {
      throw new Error('FORDEFI_VAULT_ID is not configured');
    }

    return {
      signer_type: 'api_signer',
      type: 'evm_transaction',
      details: {
        type: 'evm_raw_transaction',
        to,
        value: '0',
        gas: {
          type: gasOptions?.type || 'priority',
          priority_level: gasOptions?.priority_level || 'medium',
        },
        fail_on_prediction_failure: false,
        chain,
        data: {
          type: 'hex',
          hex_data: data,
        },
      },
      note: name,
      vault_id: vaultId,
    };
  }

  /**
   * submit transaction to Fordefi API
   */
  private async submitTransaction(
    request: FordefiTransactionRequest,
  ): Promise<string> {
    const accessToken = this.configService.get('fordefi.accessToken');
    const secretPath = this.configService.get('fordefi.secretPath');

    if (!accessToken) {
      throw new Error('FORDEFI_ACCESS_TOKEN is not configured');
    }

    if (!secretPath) {
      throw new Error('FORDEFI_SECRET_PATH is not configured');
    }

    const requestBody = JSON.stringify(request);
    const path = '/api/v1/transactions';
    const timestamp = new Date().getTime();
    const payload = `${path}|${timestamp}|${requestBody}`;

    try {
      const secretPem = fs.readFileSync(secretPath, 'utf8');
      const privateKey = crypto.createPrivateKey(secretPem);
      const sign = crypto.createSign('SHA256').update(payload, 'utf8').end();
      const signature = sign.sign(privateKey, 'base64');

      const response = await fetch(`https://${this.gatewayHost}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Timestamp': timestamp.toString(),
          'X-Signature': signature,
        },
        body: requestBody,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      return result.id;
    } catch (error) {
      this.logger.error(`Failed to submit transaction: ${error.message}`);
      throw error;
    }
  }

  /**
   * wait for transaction to be mined and return the hash
   */
  private async waitForTransaction(transactionId: string): Promise<Hex> {
    const accessToken = this.configService.get('fordefi.accessToken');
    const path = '/api/v1/transactions';

    let timeout = this.initialTimeout;
    const startTime = Date.now();

    while (Date.now() - startTime < this.maxTimeout) {
      try {
        const response = await fetch(
          `https://${this.gatewayHost}${path}/${transactionId}`,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const transaction: FordefiTransactionStatus = await response.json();

        // check if transaction is successfully mined
        if (
          transaction.hash &&
          transaction.mined_result?.reversion?.state === 'not_reverted'
        ) {
          return transaction.hash;
        }

        // check if transaction failed
        if (transaction.hash && transaction.mined_result?.reversion?.reason) {
          throw new Error(
            JSON.stringify({
              id: transaction.hash,
              reason: transaction.mined_result.reversion.reason,
            }),
          );
        }

        // wait before next check
        await this.sleep(timeout);
        timeout = Math.min(timeout * 2, 5000); // Cap at 5 seconds
      } catch (error) {
        this.logger.warn(`Error checking transaction status: ${error.message}`);
        await this.sleep(timeout);
        timeout = Math.min(timeout * 2, 5000);
      }
    }

    throw new Error(
      `Transaction ${transactionId} timeout after ${this.maxTimeout}ms`,
    );
  }

  /**
   * check if Fordefi is properly configured
   */
  isConfigured(): boolean {
    const accessToken = this.configService.get('fordefi.accessToken');
    const vaultId = this.configService.get('fordefi.vaultId');
    const secretPath = this.configService.get('fordefi.secretPath');

    return !!(accessToken && vaultId && secretPath);
  }

  /**
   * get transaction status from Fordefi
   */
  async getTransactionStatus(
    transactionId: string,
  ): Promise<FordefiTransactionStatus> {
    const accessToken = this.configService.get('fordefi.accessToken');
    const path = '/api/v1/transactions';

    const response = await fetch(
      `https://${this.gatewayHost}${path}/${transactionId}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
