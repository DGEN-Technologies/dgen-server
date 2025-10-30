/**
 * Background Task Manager
 * Manages background tasks that don't require user context
 */

import { Logger } from 'pino';
import { getServiceInjector } from '../services';

export class BackgroundTaskManager {
  private static instance: BackgroundTaskManager;
  private logger: Logger;
  private tasks: Map<string, NodeJS.Timeout> = new Map();
  private isShuttingDown: boolean = false;
  
  private constructor() {
    this.logger = getServiceInjector().getLogger();
  }
  
  public static getInstance(): BackgroundTaskManager {
    if (!BackgroundTaskManager.instance) {
      BackgroundTaskManager.instance = new BackgroundTaskManager();
    }
    return BackgroundTaskManager.instance;
  }
  
  /**
   * Start all background tasks
   */
  public async startTasks() {
    this.logger.info('Starting background tasks');
    
    // Start rate monitoring (doesn't need user context)
    this.startRateMonitoring();
    
    // Start health checks
    this.startHealthChecks();
  }
  
  /**
   * Start rate monitoring
   */
  private async startRateMonitoring() {
    try {
      const { getFx } = await import('../rates');
      await getFx(); // Initialize FX rates and WebSocket connection
      this.logger.info('Rate monitoring started');
    } catch (error) {
      this.logger.error(`Failed to start rate monitoring: ${error.message}`);
      // Schedule retry
      if (!this.isShuttingDown) {
        setTimeout(() => this.startRateMonitoring(), 30000);
      }
    }
  }
  
  /**
   * Start health checks
   */
  private startHealthChecks() {
    const healthCheck = async () => {
      if (this.isShuttingDown) return;

      try {
        // Check database connection
        const { db } = await import('../db');
        await db.ping();

        this.logger.debug('Health check passed');
      } catch (error) {
        this.logger.warn(`Health check failed: ${error.message}`);
      }
    };
    
    // Run health check every 30 seconds
    const interval = setInterval(() => healthCheck(), 30000);
    this.tasks.set('healthCheck', interval);
    
    // Run once immediately
    healthCheck();
  }
  
  /**
   * Stop all background tasks
   */
  public async stopTasks() {
    this.logger.info('Stopping background tasks');
    this.isShuttingDown = true;
    
    // Clear all intervals
    for (const [name, task] of this.tasks) {
      clearInterval(task);
      this.logger.debug(`Stopped task: ${name}`);
    }
    this.tasks.clear();
  }
  
  /**
   * Register a custom background task
   */
  public registerTask(name: string, interval: number, handler: () => Promise<void>) {
    if (this.tasks.has(name)) {
      this.logger.warn(`Task ${name} already registered, replacing`);
      clearInterval(this.tasks.get(name)!);
    }
    
    const wrapper = async () => {
      if (this.isShuttingDown) return;
      try {
        await handler();
      } catch (error) {
        this.logger.error(`Background task ${name} failed: ${error.message}`);
      }
    };
    
    const taskInterval = setInterval(wrapper, interval);
    this.tasks.set(name, taskInterval);
    
    // Run once immediately
    wrapper();
    
    this.logger.info(`Registered background task: ${name} (interval: ${interval}ms)`);
  }
  
  /**
   * Unregister a background task
   */
  public unregisterTask(name: string) {
    const task = this.tasks.get(name);
    if (task) {
      clearInterval(task);
      this.tasks.delete(name);
      this.logger.info(`Unregistered background task: ${name}`);
    }
  }
  
  /**
   * Get task status
   */
  public getTaskStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const name of this.tasks.keys()) {
      status[name] = true;
    }
    return status;
  }
}