interface Connection {
  id: string;
  lastActivity: number;
  isActive: boolean;
}

interface ConnectionPoolConfig {
  maxConnections?: number;
  maxConnectionsPerIP?: number;
  idleTimeout?: number;
}

export class ConnectionPool {
  private static instance: ConnectionPool;
  private connections = new Map<string, Connection>();
  private readonly maxConnections: number;
  private readonly idleTimeout: number;
  private cleanupInterval: NodeJS.Timeout;

  static getInstance(config?: ConnectionPoolConfig): ConnectionPool {
    if (!ConnectionPool.instance) {
      ConnectionPool.instance = new ConnectionPool(config);
    }
    return ConnectionPool.instance;
  }

  private constructor(config?: ConnectionPoolConfig) {
    this.maxConnections = config?.maxConnections
      ?? parseInt(process.env.MAX_WEBSOCKET_CONNECTIONS || "10000");
    this.idleTimeout = config?.idleTimeout ?? 300000; // 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  addConnection(id: string): boolean {
    // Aggressive cleanup if approaching limit
    if (this.connections.size >= this.maxConnections * 0.8) {
      this.aggressiveCleanup();
    }

    if (this.connections.size >= this.maxConnections) {
      // Try one more aggressive cleanup
      this.aggressiveCleanup();
      if (this.connections.size >= this.maxConnections) {
        console.error(`Connection pool full: ${this.connections.size}/${this.maxConnections}`);
        return false;
      }
    }

    this.connections.set(id, {
      id,
      lastActivity: Date.now(),
      isActive: true
    });
    return true;
  }

  private aggressiveCleanup(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    // More aggressive timeout during high load
    const timeout = this.connections.size > this.maxConnections * 0.8
      ? 60000  // 1 minute during high load
      : this.idleTimeout;

    for (const [id, conn] of this.connections) {
      if (now - conn.lastActivity > timeout || !conn.isActive) {
        toRemove.push(id);
      }
    }

    toRemove.forEach(id => this.connections.delete(id));

    if (toRemove.length > 0) {
      console.log(`ConnectionPool: Aggressive cleanup removed ${toRemove.length} connections`);
    }
  }

  updateActivity(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.lastActivity = Date.now();
    }
  }

  removeConnection(id: string): void {
    this.connections.delete(id);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, conn] of this.connections) {
      if (now - conn.lastActivity > this.idleTimeout) {
        this.connections.delete(id);
      }
    }
  }

  getStats() {
    return {
      total: this.connections.size,
      active: Array.from(this.connections.values()).filter(c => c.isActive).length,
      maxConnections: this.maxConnections
    };
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.connections.clear();
  }
}

export const connectionPool = ConnectionPool.getInstance();