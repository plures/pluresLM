/**
 * Gateway IPC Request Handler - processes CLI requests in gateway process
 * 
 * Runs in gateway process to handle CLI requests and return real data
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PluresDBBackend } from "./pluresdb-backend.js";

interface IpcRequest {
  id: string;
  command: string;
  args: Record<string, unknown>;
  timestamp: number;
}

interface IpcResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
  timestamp: number;
}

export class GatewayIpcHandler {
  private ipcDir: string;
  private requestsDir: string;
  private responsesDir: string;
  private isWatching = false;
  private db: PluresDBBackend;

  constructor(db: PluresDBBackend) {
    this.db = db;
    this.ipcDir = path.join(process.env.HOME || '/tmp', '.pluresLM', 'ipc');
    this.requestsDir = path.join(this.ipcDir, 'requests');
    this.responsesDir = path.join(this.ipcDir, 'responses');
    
    // Ensure directories exist
    try {
      fs.mkdirSync(this.requestsDir, { recursive: true });
      fs.mkdirSync(this.responsesDir, { recursive: true });
    } catch (err) {
      console.warn("[GatewayIpcHandler] Failed to create IPC directories:", err);
    }
  }

  start(): void {
    if (this.isWatching) return;
    
    this.isWatching = true;
    console.log("[GatewayIpcHandler] Starting IPC request handler for CLI communication");
    
    // Watch for new request files
    this.watchRequests();
  }

  stop(): void {
    this.isWatching = false;
    console.log("[GatewayIpcHandler] Stopped IPC request handler");
  }

  private watchRequests(): void {
    // Simple polling approach (could upgrade to fs.watch later)
    const checkRequests = () => {
      if (!this.isWatching) return;
      
      try {
        const files = fs.readdirSync(this.requestsDir);
        const requestFiles = files.filter(f => f.endsWith('.json'));
        
        for (const file of requestFiles) {
          this.processRequest(file);
        }
      } catch {
        // Directory might not exist or be temporarily unavailable
      }
      
      // Check again in 500ms
      setTimeout(checkRequests, 500);
    };
    
    checkRequests();
  }

  private async processRequest(filename: string): Promise<void> {
    const requestFile = path.join(this.requestsDir, filename);
    
    try {
      // Read and parse request
      const requestData = fs.readFileSync(requestFile, 'utf8');
      const request: IpcRequest = JSON.parse(requestData);
      
      console.log(`[GatewayIpcHandler] Processing CLI request: ${request.command}`);
      
      let response: IpcResponse;
      
      try {
        // Execute the command using the gateway's database
        const result = await this.executeCommand(request.command, request.args);
        response = {
          id: request.id,
          success: true,
          data: result,
          timestamp: Date.now()
        };
      } catch (error) {
        response = {
          id: request.id,
          success: false,
          error: String(error),
          timestamp: Date.now()
        };
      }
      
      // Write response file
      const responseFile = path.join(this.responsesDir, filename);
      fs.writeFileSync(responseFile, JSON.stringify(response, null, 2));
      
      // Clean up request file
      fs.unlinkSync(requestFile);
      
      console.log(`[GatewayIpcHandler] Completed CLI request: ${request.command}`);
      
    } catch (error) {
      console.error(`[GatewayIpcHandler] Failed to process request ${filename}:`, error);
      
      // Clean up failed request
      try {
        fs.unlinkSync(requestFile);
      } catch {
        // Cleanup failure is non-critical
      }
    }
  }

  private async executeCommand(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'ping':
        return { status: 'ok', timestamp: Date.now() };
        
      case 'stats': {
        const stats = await this.db.stats();
        const profile = await this.db.getProfile();
        return {
          ...stats,
          lastCaptureTime: stats.lastCaptureTime ? new Date(stats.lastCaptureTime).toISOString() : null,
          profileSummary: profile?.summary?.slice(0, 200) ?? "No profile yet",
        };
      }
        
      case 'execDsl':
        return await this.db.execDsl(args['query'] as string);
        
      case 'search':
        return await this.db.vectorSearch(args['query'] as number[], args['limit'] as number || 20, args['minSimilarity'] as number || 0.1);
        
      case 'getProfile':
        return await this.db.getProfile();
        
      case 'put':
      case 'store': {
        // Store a memory via IPC
        const memory = args['memory'] as Record<string, unknown> | undefined;
        if (!memory || !memory['content']) {
          throw new Error('Invalid memory data: content is required');
        }
        
        return await this.db.store(
          memory['content'] as string,
          memory['embedding'] as number[] | undefined ?? [],
          {
            source: memory['source'] as string || '',
            tags: Array.isArray(memory['tags']) ? memory['tags'] as string[] : [],
            category: memory['category'] as string || 'other',
            priority: (memory['priority'] as string || 'normal') as import("./types.js").MemoryPriority,
            importanceScore: memory['importance_score'] as number || 1.0
          }
        );
      }
        
      case 'worldState': {
        // Generate world state summary
        const memories = await this.db.listMemories();
        const categories = memories.reduce((acc, m) => {
          acc[m.category] = (acc[m.category] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        
        return {
          totalMemories: memories.length,
          categories,
          lastUpdate: new Date().toISOString()
        };
      }
        
      case 'consolidate':
        // Run consolidation with provided options
        return { status: 'consolidation not implemented via IPC yet' };
        
      case 'findStale': {
        const cutoffTime = Date.now() - ((args['days'] as number || 30) * 24 * 60 * 60 * 1000);
        const allMemories = await this.db.listMemories();
        return allMemories.filter(m => m.created_at < cutoffTime);
      }
        
      default:
        throw new Error(`Unknown IPC command: ${command}`);
    }
  }
}