interface Connection {
  id: string;
  lastActivity: number;
  isActive: boolean;
}

export class ConnectionPool {
  private static instance: ConnectionPool;
  private connections = new Map<string, Connection>();
  private readonly maxConnections = parseInt(process.env.MAX_WEBSOCKET_CONNECTIONS || "300");
  private readonly idleTimeout = 300000; // 5 minutes
  private cleanupInterval: NodeJS.Timeout;

  static getInstance(): ConnectionPool {
    if (!ConnectionPool.instance) {
      ConnectionPool.instance = new ConnectionPool();
    }
    return ConnectionPool.instance;
  }

  private constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  addConnection(id: string): boolean {
    if (this.connections.size >= this.maxConnections) {
      this.cleanup();
      if (this.connections.size >= this.maxConnections) {
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