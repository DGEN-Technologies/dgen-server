import { FastifyInstance, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { getConfig } from '../config-loader';
import { getUser } from '../utils';
import { l, err, warn } from '../logging';
import store from '../store';
import { RateLimiter } from '../security/RateLimiter';
import { ConnectionPool } from '../performance/ConnectionPool';

interface WebSocketConnection {
  id: string;
  ws: WebSocket;
  userId: string;
  username: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  subscriptions: Set<string>;
}

interface WebSocketMessage {
  type: string;
  data?: any;
  id?: string;
}

export class WebSocketManager extends EventEmitter {
  private static instance: WebSocketManager;
  private connections: Map<string, WebSocketConnection> = new Map();
  private userConnections: Map<string, Set<string>> = new Map();
  private rateLimiter: RateLimiter;
  private connectionPool: ConnectionPool;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isRegistered = false;
  
  // Production configuration
  private readonly MAX_CONNECTIONS_PER_USER = 3;
  private readonly MAX_MESSAGE_SIZE = 1048576; // 1MB
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 120000; // 2 minutes
  private readonly CLEANUP_INTERVAL = 60000; // 1 minute
  private readonly MAX_MESSAGES_PER_MINUTE = 60;
  
  private constructor() {
    super();
    this.rateLimiter = new RateLimiter({
      windowMs: 60000,
      maxRequests: this.MAX_MESSAGES_PER_MINUTE
    });
    this.connectionPool = new ConnectionPool({
      maxConnections: 1000,
      maxConnectionsPerIP: 10
    });
    this.setupIntervals();
  }

  public static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }

  private setupIntervals(): void {
    // Heartbeat interval
    this.heartbeatInterval = setInterval(() => {
      this.connections.forEach((connection) => {
        if (Date.now() - connection.lastActivity > this.CONNECTION_TIMEOUT) {
          this.handleDisconnect(connection.id);
        } else {
          connection.ws.ping();
        }
      });
    }, this.HEARTBEAT_INTERVAL);

    // Cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.CLEANUP_INTERVAL);
  }

  public async register(app: FastifyInstance): Promise<void> {
    if (this.isRegistered) {
      l('WebSocket manager already registered, skipping');
      return;
    }

    try {
      // Register WebSocket plugin
      await app.register(require('@fastify/websocket'), {
        options: {
          maxPayload: this.MAX_MESSAGE_SIZE,
          perMessageDeflate: false,
          // Add these options for Railway compatibility
          clientTracking: true,
          verifyClient: (info: any, next: any) => {
            const origin = info.origin || info.req.headers.origin;
            console.log(`[WebSocket] Connection attempt from origin: ${origin}`);
            
            // In production, check CORS
            if (process.env.NODE_ENV === 'production') {
              const config = getConfig();
              const allowedOrigins = config.cors?.allowedOrigins || [];
              
              if (origin && allowedOrigins.length > 0) {
                if (allowedOrigins.includes(origin)) {
                  console.log(`[WebSocket] Origin allowed: ${origin}`);
                  next(true);
                } else {
                  console.log(`[WebSocket] Origin rejected: ${origin}, allowed: ${allowedOrigins.join(', ')}`);
                  next(false, 403, 'Origin not allowed');
                }
              } else {
                // No origin or no restrictions
                next(true);
              }
            } else {
              // Development - allow all
              next(true);
            }
          }
        }
      });

      // Register WebSocket route
      app.get('/ws', { websocket: true }, (connection, req) => {
        this.handleConnection(connection, req);
      });

      // Also register a test endpoint to verify WebSocket is available
      app.get('/ws-test', async (req, reply) => {
        reply.send({ 
          websocket: 'available', 
          endpoint: '/ws',
          status: 'ready'
        });
      });

      this.isRegistered = true;
      l('WebSocket manager registered successfully on /ws endpoint');
      console.log('WebSocket endpoint registered at /ws');
    } catch (error) {
      err('Failed to register WebSocket manager:', error);
      console.error('WebSocket registration failed:', error);
      throw error;
    }
  }

  private handleConnection(connection: any, request: FastifyRequest): void {
    // In fastify-websocket, the connection parameter is the WebSocket directly
    const ws = connection as WebSocket;
    const connectionId = this.generateConnectionId();
    
    // Allow connection without immediate authentication
    // The client will send authentication in the first message
    const pendingConnection: WebSocketConnection = {
      id: connectionId,
      ws,
      userId: 'pending',
      username: 'pending',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      subscriptions: new Set()
    };
    
    // Store as pending connection
    this.connections.set(connectionId, pendingConnection);
    
    // Set authentication timeout
    const authTimeout = setTimeout(() => {
      const conn = this.connections.get(connectionId);
      if (conn && conn.userId === 'pending') {
        try {
          if (typeof ws.close === 'function') {
            ws.close(1008, 'Authentication timeout');
          } else if (typeof ws.terminate === 'function') {
            ws.terminate();
          }
        } catch (e) {
          this.logger.error('Error closing WebSocket on timeout:', e);
        }
        this.connections.delete(connectionId);
      }
    }, 10000); // 10 second timeout for authentication
    
    // Handle incoming messages - support both Bun and Node.js WebSocket APIs
    const handleMessage = async (data: Buffer | string) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        const conn = this.connections.get(connectionId);
        if (!conn) return;
        
        // Handle authentication messages (login, heartbeat with token)
        if ((message.type === 'login' || message.type === 'heartbeat') && message.data && conn.userId === 'pending') {
          // Authenticate the connection
          const authenticated = await this.authenticateConnection(connectionId, message.data);
          if (authenticated) {
            clearTimeout(authTimeout);
            // Send connected message to confirm authentication
            this.sendToConnection(connectionId, { type: 'connected' });
          } else {
            try {
              if (typeof ws.close === 'function') {
                ws.close(1008, 'Authentication failed');
              } else if (typeof ws.terminate === 'function') {
                ws.terminate();
              }
            } catch (e) {
              this.logger.error('Error closing WebSocket:', e);
            }
            this.connections.delete(connectionId);
          }
          return;
        }
        
        // For authenticated connections, handle other messages
        if (conn.userId !== 'pending') {
          await this.handleMessage(connectionId, message);
        } else {
          // Unauthenticated connection trying to send non-auth messages
          try {
            if (typeof ws.send === 'function') {
              ws.send(JSON.stringify({ type: 'error', data: { message: 'Authentication required' } }));
            }
          } catch (e) {
            this.logger.error('Error sending to WebSocket:', e);
          }
        }
      } catch (error) {
        err('Error handling WebSocket message:', error);
      }
    };
    
    // Set up message and close handlers based on WebSocket API type
    if (typeof ws.on === 'function') {
      // Node.js ws library
      ws.on('message', handleMessage);
      ws.on('close', () => {
        clearTimeout(authTimeout);
        this.handleDisconnect(connectionId);
      });
      ws.on('error', (error) => {
        err(`WebSocket error for connection ${connectionId}:`, error);
        this.handleDisconnect(connectionId);
      });
      ws.on('pong', () => {
        const conn = this.connections.get(connectionId);
        if (conn) {
          conn.lastActivity = Date.now();
        }
      });
    } else if (typeof ws.addEventListener === 'function') {
      // Standard WebSocket API (Bun)
      ws.addEventListener('message', (event: any) => {
        handleMessage(event.data);
      });
      ws.addEventListener('close', () => {
        clearTimeout(authTimeout);
        this.handleDisconnect(connectionId);
      });
      ws.addEventListener('error', (event: any) => {
        err(`WebSocket error for connection ${connectionId}:`, event);
        this.handleDisconnect(connectionId);
      });
    } else {
      // Fallback for Bun's direct property assignment
      (ws as any).onmessage = (event: any) => {
        handleMessage(event.data);
      };
      (ws as any).onclose = () => {
        clearTimeout(authTimeout);
        this.handleDisconnect(connectionId);
      };
      (ws as any).onerror = (event: any) => {
        err(`WebSocket error for connection ${connectionId}:`, event);
        this.handleDisconnect(connectionId);
      };
    }
  }

  private async authenticateConnection(connectionId: string, token: string): Promise<boolean> {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;

    try {
      const decoded = await new Promise<any>((resolve, reject) => {
        jwt.verify(token, getConfig().jwt, (error, decoded) => {
          if (error) reject(error);
          else resolve(decoded);
        });
      });

      const user = await getUser(decoded.id);
      if (!user) {
        warn(`Authentication failed: User not found for id ${decoded.id}`);
        return false;
      }

      // Check connection limits
      if (!this.canConnect(user.id)) {
        warn(`Connection limit exceeded for user ${user.id}`);
        connection.ws.close(1013, 'Too many connections');
        return false;
      }

      // Update connection with user info
      connection.userId = user.id;
      connection.username = user.username;

      // Store user connection
      if (!this.userConnections.has(user.id)) {
        this.userConnections.set(user.id, new Set());
      }
      this.userConnections.get(user.id)!.add(connectionId);

      // Store in legacy store for backward compatibility
      if (!store.sockets[user.id]) store.sockets[user.id] = {};
      store.sockets[user.id][connectionId] = connection.ws;

      // Note: Breez SDK is now client-side only (in dgen-ui)
      // No server-side SDK management needed

      l(`WebSocket authenticated: user=${user.username} connection=${connectionId}`);
      this.emit('connection', { userId: user.id, connectionId });

      return true;
    } catch (error) {
      err('Authentication error:', error);
      return false;
    }
  }

  private async handleMessage(connectionId: string, message: WebSocketMessage): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.userId === 'pending') return;

    // Rate limiting
    if (!this.rateLimiter.check(connection.userId)) {
      this.sendToConnection(connectionId, {
        type: 'error',
        data: { message: 'Rate limit exceeded' }
      });
      return;
    }

    connection.lastActivity = Date.now();
    connection.messageCount++;

    const { type, data } = message;

    switch (type) {
      case 'ping':
        this.sendToConnection(connectionId, { type: 'pong', data: Date.now() });
        break;
        
      case 'heartbeat':
        connection.lastActivity = Date.now();
        store.last = Date.now();
        this.sendToConnection(connectionId, { type: 'heartbeat', data: Date.now() });
        break;
        
      case 'login':
        // Already authenticated, send confirmation
        this.sendToConnection(connectionId, { type: 'connected' });
        break;
        
      case 'subscribe':
        if (data?.channel) {
          connection.subscriptions.add(data.channel);
          this.sendToConnection(connectionId, {
            type: 'subscribed',
            data: { channel: data.channel }
          });
        }
        break;
        
      case 'unsubscribe':
        if (data?.channel) {
          connection.subscriptions.delete(data.channel);
          this.sendToConnection(connectionId, {
            type: 'unsubscribed',
            data: { channel: data.channel }
          });
        }
        break;
        
      default:
        // Emit custom event for application-specific handling
        this.emit('message', { connectionId, userId: connection.userId, message });
        break;
    }
  }

  private handleDisconnect(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    // Remove from user connections
    if (connection.userId !== 'pending') {
      const userConns = this.userConnections.get(connection.userId);
      if (userConns) {
        userConns.delete(connectionId);
        if (userConns.size === 0) {
          this.userConnections.delete(connection.userId);
          
          // User has no more connections - they've closed the app
          l(`User ${connection.username} disconnected - cleaning up SDK instance`);

          // Note: Breez SDK is now client-side only (in dgen-ui)
          // No server-side SDK cleanup needed
        }
      }

      // Remove from legacy store
      if (store.sockets[connection.userId]) {
        delete store.sockets[connection.userId][connectionId];
        if (Object.keys(store.sockets[connection.userId]).length === 0) {
          delete store.sockets[connection.userId];
        }
      }

      l(`WebSocket disconnected: user=${connection.username} connection=${connectionId}`);
      this.emit('disconnection', { userId: connection.userId, connectionId });
    }

    // Remove connection
    this.connections.delete(connectionId);
  }

  private canConnect(userId: string): boolean {
    const userConns = this.userConnections.get(userId);
    return !userConns || userConns.size < this.MAX_CONNECTIONS_PER_USER;
  }

  private sendToConnection(connectionId: string, message: WebSocketMessage): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    const ws = connection.ws;
    const messageStr = JSON.stringify(message);
    
    try {
      // Check if WebSocket is open (different APIs have different ways)
      const isOpen = ws.readyState === WebSocket.OPEN || 
                     ws.readyState === 1 || // Standard OPEN state
                     (ws as any).readyState === 'OPEN';
      
      if (isOpen) {
        if (typeof ws.send === 'function') {
          ws.send(messageStr);
        } else {
          this.logger.error('WebSocket does not have send method');
        }
      }
    } catch (e) {
      this.logger.error('Error sending WebSocket message:', e);
    }
  }

  public sendToUser(userId: string, message: WebSocketMessage): void {
    const userConns = this.userConnections.get(userId);
    if (!userConns) return;

    userConns.forEach(connectionId => {
      this.sendToConnection(connectionId, message);
    });
  }

  public broadcast(message: WebSocketMessage, filter?: (conn: WebSocketConnection) => boolean): void {
    this.connections.forEach((connection) => {
      if (connection.userId !== 'pending' && (!filter || filter(connection))) {
        this.sendToConnection(connection.id, message);
      }
    });
  }

  public broadcastToChannel(channel: string, message: WebSocketMessage): void {
    this.connections.forEach((connection) => {
      if (connection.subscriptions.has(channel)) {
        this.sendToConnection(connection.id, message);
      }
    });
  }

  private cleanup(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    this.connections.forEach((connection, id) => {
      if (now - connection.lastActivity > this.CONNECTION_TIMEOUT) {
        toRemove.push(id);
      }
    });

    toRemove.forEach(id => {
      const connection = this.connections.get(id);
      if (connection) {
        connection.ws.close(1000, 'Connection timeout');
        this.handleDisconnect(id);
      }
    });

    if (toRemove.length > 0) {
      l(`Cleaned up ${toRemove.length} timed out connections`);
    }
  }

  private generateConnectionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  public async shutdown(): Promise<void> {
    l('Shutting down WebSocket manager...');
    
    // Clear intervals
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Close all connections
    this.connections.forEach((connection) => {
      connection.ws.close(1001, 'Server shutting down');
    });

    // Clear maps
    this.connections.clear();
    this.userConnections.clear();
    
    // Clear legacy store
    store.sockets = {};
    
    l('WebSocket manager shutdown complete');
  }

  // Utility methods for monitoring
  public getStats(): any {
    return {
      totalConnections: this.connections.size,
      authenticatedConnections: Array.from(this.connections.values()).filter(c => c.userId !== 'pending').length,
      pendingConnections: Array.from(this.connections.values()).filter(c => c.userId === 'pending').length,
      uniqueUsers: this.userConnections.size,
      rateLimiter: this.rateLimiter.getStats()
    };
  }
}

// Export singleton instance
export const websocketManager = WebSocketManager.getInstance();