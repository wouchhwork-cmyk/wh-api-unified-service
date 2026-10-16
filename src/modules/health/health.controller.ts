import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public, RequirePlatformAdmin } from '@/shared/decorators';
import { HealthService, type HealthReport, type LivenessReport } from './health.service';

/**
 * Three endpoints, because an orchestrator asks three different questions
 * (backend-design.md §13.1). Conflating them is how a database hiccup becomes a
 * cascading restart loop.
 */
@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @Public()
  @ApiOperation({
    summary: 'Is the process alive?',
    description:
      'NEVER touches the database. A slow query must not restart the process — that is how a ' +
      'database hiccup becomes a cascading restart loop. Failing this kills the pod.',
  })
  live(): LivenessReport {
    return this.health.liveness();
  }

  @Get('ready')
  @Public()
  @ApiOperation({
    summary: 'Should this instance receive traffic?',
    description:
      'Checks the database and that no migration is pending. Failing sheds traffic from the ' +
      'load balancer without killing the process.',
  })
  async ready(): Promise<HealthReport> {
    const report = await this.health.readiness();
    // The STATUS CODE is what an orchestrator reads. Reporting "degraded" in a
    // 200 body means the instance is never pulled from the load balancer, which
    // defeats the entire point of a readiness probe.
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }

  @Get('startup')
  @Public()
  @ApiOperation({
    summary: 'Has the process finished booting?',
    description: 'Separate from liveness so a slow start does not trigger premature restarts.',
  })
  async startup(): Promise<HealthReport> {
    const report = await this.health.startup();
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }

  @Get('detail')
  /*
   * PLATFORM STAFF, not any authenticated viewer.
   *
   * It was gated on `enterprise.view`, which every enterprise role holds
   * including the read-only viewer — and it returns PLATFORM-WIDE queue gauges
   * plus database and Meta configuration. No tenant data, so this was metadata
   * disclosure rather than a boundary break, but it is one business being shown
   * the shape of every other one's traffic. It also runs three unfiltered
   * aggregate scans over the event ledgers on every call, which is not something
   * to leave reachable by an ordinary role.
   */
  @RequirePlatformAdmin()
  @ApiOperation({
    summary: 'The diagnostic breakdown (platform staff only)',
    description:
      'The three public endpoints deliberately carry no version, hostname, or dependency detail. ' +
      'That information lives here, and it is platform-wide rather than per-tenant — so it is ' +
      'gated on platform staff, not on a tenant permission.',
  })
  async detail(): Promise<Record<string, unknown>> {
    return this.health.detail();
  }
}
