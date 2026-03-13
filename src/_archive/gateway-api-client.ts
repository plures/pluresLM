/**
 * Simple Database Retry Client - handles temporary locks with exponential backoff
 * 
 * Plus file-based IPC client for gateway communication
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

interface IpcRequest {
  id: string;
  command: string;
  args: any;
  timestamp: number;
}

interface IpcResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  timestamp: number;
}

export class GatewayIpcClient {
  private ipcDir: string;
  private requestsDir: string;
  private responsesDir: string;

  constructor() {
    this.ipcDir = path.join(process.env.HOME || '/tmp', '.pluresLM', 'ipc');
    this.requestsDir = path.join(this.ipcDir, 'requests');
    this.responsesDir = path.join(this.ipcDir, 'responses');
  }

  async isGatewayAvailable(): Promise<boolean> {
    try {
      const result = await this.sendRequest('ping', {}, 2000); // Quick 2s timeout for ping
      return result && result.status === 'ok';
    } catch {
      return false;
    }
  }

  async getStats(): Promise<any> {
    return await this.sendRequest('stats', {});
  }

  async execDsl(query: string): Promise<any> {
    return await this.sendRequest('execDsl', { query });
  }

  async getProfile(): Promise<any> {
    return await this.sendRequest('getProfile', {});
  }

  private async sendRequest(command: string, args: any, timeoutMs = 10000): Promise<any> {
    // Ensure directories exist
    try {
      fs.mkdirSync(this.requestsDir, { recursive: true });
      fs.mkdirSync(this.responsesDir, { recursive: true });
    } catch {
      throw new Error('Cannot create IPC directories - gateway not accessible');
    }

    const requestId = crypto.randomUUID();
    const request: IpcRequest = {
      id: requestId,
      command,
      args,
      timestamp: Date.now()
    };

    const requestFile = path.join(this.requestsDir, `${requestId}.json`);
    const responseFile = path.join(this.responsesDir, `${requestId}.json`);
    
    try {
      // Write request file
      fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));
      
      // Wait for response file
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        if (fs.existsSync(responseFile)) {
          try {
            const responseData = fs.readFileSync(responseFile, 'utf8');
            const response: IpcResponse = JSON.parse(responseData);
            
            // Cleanup files
            try {
              fs.unlinkSync(requestFile);
              fs.unlinkSync(responseFile);
            } catch {
              // Cleanup failure is non-critical
            }
            
            if (response.success) {
              return response.data;
            } else {
              throw new Error(response.error || 'Gateway request failed');
            }
          } catch (parseErr) {
            throw new Error(`Failed to parse gateway response: ${String(parseErr)}`);
          }
        }
        
        // Wait 100ms before checking again
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      throw new Error(`Gateway request timeout after ${timeoutMs}ms`);
      
    } catch (error) {
      // Cleanup request file on error
      try {
        fs.unlinkSync(requestFile);
      } catch {
        // Cleanup failure is non-critical
      }
      throw error;
    }
  }
}

export async function createGatewayClientOrFallback(): Promise<{ client: GatewayIpcClient | null; useDatabase: boolean }> {
  const client = new GatewayIpcClient();
  
  try {
    const isAvailable = await client.isGatewayAvailable();
    if (isAvailable) {
      console.log("[PluresLM] Using gateway IPC for data access");
      return { client, useDatabase: false };
    }
  } catch (error) {
    console.log(`[PluresLM] Gateway IPC unavailable: ${String(error)}`);
  }
  
  console.log("[PluresLM] Gateway IPC not available - falling back to direct database access");
  return { client: null, useDatabase: true };
}

export class DatabaseRetryClient {
  static async withRetry<T>(operation: () => Promise<T>, maxRetries = 5): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        if (lastError.message?.includes("could not acquire lock") || 
            lastError.message?.includes("Database temporarily locked") ||
            lastError.message?.includes("resource temporarily unavailable")) {
          
          const delay = Math.min(500 * Math.pow(1.5, attempt), 3000); // Max 3 second delay
          console.log(`[CLI] Database busy, retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Non-lock error, don't retry
          throw error;
        }
      }
    }
    
    // All retries failed
    throw new Error(`Database access failed after ${maxRetries} attempts. The gateway may be using the database exclusively. Try again later or check if the gateway is running properly. Last error: ${lastError?.message}`);
  }
}