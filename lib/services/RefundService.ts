import { Logger } from "./Logger";
import { db, g, s } from "../db";

export interface RefundableSwap {
  swapAddress: string;
  amountSat: number;
  timestamp: number;
  onchainAddress?: string;
  lockupTxId?: string;
  refundTxId?: string;
}

export interface RefundRequest {
  swapAddress: string;
  toAddress: string;
  feeRateSatPerVbyte: number;
}

export interface RefundResponse {
  refundTxId: string;
  feeSat: number;
}

export class RefundService {
  private logger: Logger;
  
  constructor(logger: Logger) {
    this.logger = logger;
  }
  
  /**
   * List all refundable swaps for a user
   */
  async listRefundables(userId: string): Promise<RefundableSwap[]> {
    try {
      // List refundable swaps using the exported function
      const refundables = await sdkListRefundables(userId);
      
      this.logger.info(`Found ${refundables.length} refundable swaps for user ${userId}`);
      
      // Log details for debugging
      if (refundables.length > 0) {
        refundables.forEach((r, i) => {
          this.logger.info(`Refundable ${i + 1}: swapAddress=${r.swapAddress}, amount=${r.amountSat} sats`);
        });
      }
      
      return refundables.map(r => ({
        swapAddress: r.swapAddress,
        amountSat: Number(r.amountSat),
        timestamp: r.timestamp,
        onchainAddress: r.onchainAddress,
        lockupTxId: r.lockupTxId,
        refundTxId: r.refundTxId
      }));
      
    } catch (error) {
      this.logger.error(`Failed to list refundables for ${userId}: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Rescan swaps to check for refundable transactions
   */
  async rescanSwaps(userId: string): Promise<number> {
    try {
      this.logger.info(`Rescanning swaps for user ${userId}`);
      
      // Rescan onchain swaps using the exported function
      await rescanOnchainSwaps(userId);
      
      // Get updated list of refundables
      const refundables = await this.listRefundables(userId);
      
      this.logger.info(`Rescan complete. Found ${refundables.length} refundable swaps`);
      
      return refundables.length;
      
    } catch (error) {
      this.logger.error(`Failed to rescan swaps for ${userId}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Prepare a refund transaction
   */
  async prepareRefund(userId: string, request: RefundRequest): Promise<any> {
    try {
      this.logger.info(`Preparing refund for swap ${request.swapAddress} to ${request.toAddress}`);
      
      const prepareResponse = await sdkPrepareRefund(
        request.swapAddress,
        request.toAddress,
        request.feeRateSatPerVbyte,
        userId
      );
      
      this.logger.info(`Refund prepared. TX fee: ${prepareResponse.txFeeSat} sats`);
      
      return prepareResponse;
      
    } catch (error) {
      this.logger.error(`Failed to prepare refund: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Execute a refund transaction
   */
  async refund(userId: string, request: RefundRequest): Promise<RefundResponse> {
    try {
      this.logger.info(`Processing refund for swap ${request.swapAddress}`);
      
      // First prepare the refund
      const prepareResponse = await this.prepareRefund(userId, request);
      
      // Then execute the refund using the exported function
      const refundResponse = await sdkRefund(
        request.swapAddress,
        request.toAddress,
        request.feeRateSatPerVbyte,
        userId
      );
      
      this.logger.info(`Refund successful. TX ID: ${refundResponse.refundTxId}`);
      
      // Store refund record
      await s(`refund:${userId}:${Date.now()}`, {
        swapAddress: request.swapAddress,
        toAddress: request.toAddress,
        txId: refundResponse.refundTxId,
        feeSat: prepareResponse.txFeeSat,
        timestamp: Date.now()
      });
      
      return {
        refundTxId: refundResponse.refundTxId,
        feeSat: prepareResponse.txFeeSat
      };
      
    } catch (error) {
      this.logger.error(`Failed to process refund: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get recommended fees for refund transactions
   */
  async getRecommendedFees(userId: string): Promise<any> {
    try {
      // Get recommended fees using the exported function
      const fees = await sdkRecommendedFees(userId);
      
      return {
        fastest: Number(fees.fastestFee),
        halfHour: Number(fees.halfHourFee),
        hour: Number(fees.hourFee),
        economy: Number(fees.economyFee),
        minimum: Number(fees.minimumFee)
      };
      
    } catch (error) {
      this.logger.error(`Failed to get recommended fees: ${error.message}`);
      // Return default fees if SDK call fails
      return {
        fastest: 20,
        halfHour: 10,
        hour: 5,
        economy: 3,
        minimum: 1
      };
    }
  }
}