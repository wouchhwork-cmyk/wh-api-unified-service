import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { GraphApiClient } from './graph/graph-api.client';
import { GraphApiError } from './graph/graph-api.error';
import type { DiscoveredPage, GraphAccount } from './graph/graph.types';

/** Which route found the pages. Diagnostic only; it changes no behaviour. */
export type DiscoveryPath = 'accounts' | 'granular_scopes' | 'none';

export interface DiscoveryResult {
  readonly pages: readonly DiscoveredPage[];
  readonly path: DiscoveryPath;
  /** Pages we saw but could not fully read. Reported, never silently dropped. */
  readonly partialFailures: number;
}

/**
 * Finds the Pages a user administers, and the Instagram accounts linked to them.
 *
 * Both routes are ported from the socialLift implementation, which discovered
 * the second one the hard way: /me/accounts returns EMPTY for accounts in the
 * New Page Experience / business portfolios, even though the grant is fine. The
 * fallback reads the token's own granular_scopes to find the page ids. It looks
 * redundant until it is the only thing that works for a real customer.
 */
@Injectable()
export class PageDiscoveryService {
  constructor(
    private readonly graph: GraphApiClient,
    @InjectPinoLogger(PageDiscoveryService.name) private readonly logger: PinoLogger,
  ) {}

  async discover(userAccessToken: string): Promise<DiscoveryResult> {
    const fromAccounts = await this.viaAccounts(userAccessToken);
    if (fromAccounts.pages.length > 0) return fromAccounts;

    this.logger.info('no pages from /me/accounts — trying the granular_scopes fallback');
    return this.viaGranularScopes(userAccessToken);
  }

  /** The primary route: one call, with Instagram brought in by field expansion. */
  private async viaAccounts(userAccessToken: string): Promise<DiscoveryResult> {
    const pages: DiscoveredPage[] = [];
    let after: string | undefined;

    // Bounded: an unbounded cursor walk is a hang waiting for a paging bug.
    for (let page = 0; page < 20; page += 1) {
      const response = await this.graph.listAccountsWithInstagram(userAccessToken, after);
      for (const account of response.data ?? []) pages.push(toDiscoveredPage(account));

      const next = response.paging?.cursors?.after;
      if (!next || !response.paging?.next) break;
      after = next;
    }

    return { pages, path: pages.length > 0 ? 'accounts' : 'none', partialFailures: 0 };
  }

  /**
   * The fallback: read the page ids out of the token's granular_scopes, then
   * fetch each one. Tries the scopes in the order socialLift found productive —
   * pages_show_list first, since it is the scope actually about listing pages.
   */
  private async viaGranularScopes(userAccessToken: string): Promise<DiscoveryResult> {
    const debug = await this.graph.debugToken(userAccessToken);
    const scopes = debug.data?.granular_scopes ?? [];

    const preferred = ['pages_show_list', 'pages_messaging', 'pages_read_engagement'];
    let targetIds: readonly string[] = [];
    for (const name of preferred) {
      const match = scopes.find((scope) => scope.scope === name);
      if (match?.target_ids && match.target_ids.length > 0) {
        targetIds = match.target_ids;
        break;
      }
    }

    if (targetIds.length === 0) {
      return { pages: [], path: 'none', partialFailures: 0 };
    }

    const pages: DiscoveredPage[] = [];
    let partialFailures = 0;

    // Concurrent, but each failure is captured per page rather than aborting the
    // set: one inaccessible page must not lose the others.
    const results = await Promise.all(
      targetIds.map(async (pageId): Promise<DiscoveredPage> => {
        try {
          const detail = await this.graph.getPageWithInstagram(pageId, userAccessToken);
          return toDiscoveredPage({ ...detail, id: detail.id || pageId });
        } catch (error) {
          const reason =
            error instanceof GraphApiError ? `graph code ${error.code ?? 'none'}` : 'lookup failed';
          this.logger.warn({ pageId, reason }, 'could not read a page from the fallback path');
          return {
            pageId,
            pageName: null,
            pageAccessToken: null,
            category: null,
            instagramAccountId: null,
            instagramUsername: null,
            error: reason,
          };
        }
      }),
    );

    for (const page of results) {
      if (page.error) partialFailures += 1;
      pages.push(page);
    }

    return { pages, path: 'granular_scopes', partialFailures };
  }
}

function toDiscoveredPage(account: GraphAccount): DiscoveredPage {
  return {
    pageId: account.id,
    pageName: account.name ?? null,
    pageAccessToken: account.access_token ?? null,
    category: account.category ?? null,
    instagramAccountId: account.instagram_business_account?.id ?? null,
    instagramUsername: account.instagram_business_account?.username ?? null,
    error: null,
  };
}
