import { Module } from '@nestjs/common';
import { QueueMetricsRepository } from '@/database/repositories/queue-metrics.repository';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({ controllers: [HealthController], providers: [HealthService, QueueMetricsRepository] })
export class HealthModule {}
