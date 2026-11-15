import { Injectable } from '@nestjs/common';
import { MediaAnalysisRepository } from '@/database/repositories/media-analysis.repository';
import { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import {
  MEDIA_ANALYSIS_SETTING_KEY,
  MediaAnalysisService,
} from '@/modules/ai/media-analysis.service';
import { GeminiClient } from '@/modules/ai/gemini.client';
import type { UpdateMediaAnalysisSettingsInput } from '@/shared/contracts/platform/media-analysis.contract';
import type { MediaAnalysisStatus, MediaKind } from '@/shared/enums';

export interface MediaAnalysisOverview {
  /** False when the environment has no key, which explains an idle queue. */
  readonly enabled: boolean;
  readonly model: string;
  readonly prompt: string;
  readonly promptVersion: number;
  readonly queue: {
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byKind: readonly { kind: MediaKind; status: MediaAnalysisStatus; count: number }[];
    readonly total: number;
  };
  readonly spend: { readonly analyses: number; readonly totalTokens: number };
}

/**
 * What staff see and change about media description.
 *
 * COUNTS, NEVER CONTENT. Everything here is platform-wide, which is the one
 * place in this service that is legitimate — staff are watching a pipeline
 * that spans every business. That makes it exactly the place where returning a
 * description, a transcript or a customer's name would be a cross-tenant leak
 * wearing an admin badge, so the queue is reported as numbers only.
 */
@Injectable()
export class MediaAnalysisConsoleService {
  constructor(
    private readonly analyses: MediaAnalysisRepository,
    private readonly settings: PlatformSettingRepository,
    private readonly media: MediaAnalysisService,
    private readonly gemini: GeminiClient,
  ) {}

  async overview(): Promise<MediaAnalysisOverview> {
    const [current, stats, spend] = await Promise.all([
      this.media.currentSettings(),
      this.analyses.statsAcrossPlatform(),
      this.analyses.tokenTotals(),
    ]);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of stats) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
      total += row.count;
    }

    return {
      enabled: this.gemini.enabled,
      model: current.model,
      prompt: current.prompt,
      promptVersion: current.version,
      queue: {
        byStatus,
        byKind: stats.map((row) => ({
          kind: row.mediaKind,
          status: row.status,
          count: row.count,
        })),
        total,
      },
      spend,
    };
  }

  /**
   * Saves both fields, and returns the whole view back.
   *
   * NOTHING IS RE-RUN. Changing the instruction changes what happens next, not
   * what already happened — a re-analysis of everything described so far would
   * be a bill nobody approved, triggered by editing a text box. Re-running is
   * a separate, deliberate action if it is ever wanted.
   */
  async update(
    input: UpdateMediaAnalysisSettingsInput,
    employeeId: number | null,
  ): Promise<MediaAnalysisOverview> {
    await this.settings.put(
      MEDIA_ANALYSIS_SETTING_KEY,
      { model: input.model, prompt: input.prompt },
      employeeId,
    );
    return this.overview();
  }
}
