import { EventEmitter } from 'events';
import { MetricsCollector } from './MetricsCollector';
import { Logger } from '../services/interfaces';

export interface Alert {
  level: 'warning' | 'error' | 'critical';
  message: string;
  timestamp: number;
  metric?: string;
  value?: number;
  threshold?: number;
}

export class AlertManager extends EventEmitter {
  private static instance: AlertManager;
  private alerts: Alert[] = [];
  private checkInterval: NodeJS.Timer | null = null;
  private readonly maxAlerts = 100;
  private readonly checkIntervalMs = 30000; // 30 seconds

  private constructor(
    private logger: Logger,
    private metricsCollector: MetricsCollector
  ) {
    super();
    this.startMonitoring();
  }

  public static getInstance(logger?: Logger, metricsCollector?: MetricsCollector): AlertManager {
    if (!AlertManager.instance && logger && metricsCollector) {
      AlertManager.instance = new AlertManager(logger, metricsCollector);
    }
    return AlertManager.instance;
  }

  private startMonitoring(): void {
    this.checkInterval = setInterval(() => {
      this.runChecks();
    }, this.checkIntervalMs);
  }

  public async runChecks(): Promise<void> {
    try {
      await Promise.all([
        this.checkPaymentFailureRate(),
        this.checkConcurrentUsers(),
        this.checkSDKConnectionState()
      ]);
    } catch (error) {
      this.logger.error('Alert check failed', { error: error.message });
    }
  }

  private async checkPaymentFailureRate(): Promise<void> {
    try {
      const summary = await this.metricsCollector.getSummary('5m');
      const { sent, received, failed } = summary.metrics.payments;
      const totalPayments = sent + received + failed;
      
      if (totalPayments > 0) {
        const failureRate = (failed / totalPayments) * 100;
        
        if (failureRate > 5) {
          this.createAlert('critical', `High payment failure rate: ${failureRate.toFixed(1)}%`, {
            metric: 'payment_failure_rate',
            value: failureRate,
            threshold: 5
          });
        }
      }
    } catch (error) {
      this.logger.error('Payment failure rate check failed', { error: error.message });
    }
  }

  private async checkConcurrentUsers(): Promise<void> {
    try {
      const summary = await this.metricsCollector.getSummary('1m');
      const activeSessions = summary.metrics.sdk.activeSessions;
      
      if (activeSessions > 180) {
        this.createAlert('warning', `High concurrent user count: ${activeSessions}`, {
          metric: 'active_sessions',
          value: activeSessions,
          threshold: 180
        });
      }
    } catch (error) {
      this.logger.error('Concurrent users check failed', { error: error.message });
    }
  }

  private async checkSDKConnectionState(): Promise<void> {
    try {
      const summary = await this.metricsCollector.getSummary('1m');
      const connectionState = summary.metrics.sdk.connectionState;
      
      if (connectionState === 'disconnected') {
        this.createAlert('error', 'Breez SDK disconnected', {
          metric: 'sdk_connection_state',
          value: 0,
          threshold: 1
        });
      }
    } catch (error) {
      this.logger.error('SDK connection check failed', { error: error.message });
    }
  }

  private createAlert(level: Alert['level'], message: string, metadata?: { metric?: string; value?: number; threshold?: number }): void {
    const alert: Alert = {
      level,
      message,
      timestamp: Date.now(),
      ...metadata
    };

    this.alerts.unshift(alert);
    
    if (this.alerts.length > this.maxAlerts) {
      this.alerts = this.alerts.slice(0, this.maxAlerts);
    }

    this.logger.warn('Alert triggered', alert);
    this.emit('alert', alert);
  }

  public getRecentAlerts(hours: number = 24): Alert[] {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    return this.alerts.filter(alert => alert.timestamp > cutoff);
  }

  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}