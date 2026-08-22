import type { Provider } from '@/shared/enums';

export const PROVIDER_CONNECTORS = Symbol('PROVIDER_CONNECTORS');

/**
 * What every platform integration must provide to be connectable.
 *
 * Deliberately one method. The differences between providers live in what
 * happens AFTER the redirect — different token exchanges, different discovery
 * calls, different webhook subscriptions — and forcing those behind a shared
 * interface would be an abstraction that has to be fought rather than used.
 * Starting a connection is the only step that is genuinely the same shape
 * everywhere: build the URL to send the person to.
 *
 * A new provider is a new class listed in the module, not a branch in a
 * controller.
 */
export interface ProviderConnector {
  /** Which provider this connector is for. The registry is keyed on it. */
  readonly provider: Provider;

  /**
   * What to call this on a button, owned by the connector rather than the client.
   *
   * Otherwise every client hardcodes its own list of platform names, and adding
   * one means changing each of them — which defeats the point of a generic
   * connect API. "Facebook & Instagram" is one connector, not two.
   */
  readonly label: string;

  /**
   * The URL to send the browser to, including whatever CSRF state the provider's
   * flow needs. Writing that state is part of building the URL, which is why
   * this returns a promise.
   */
  buildAuthorizationUrl(enterpriseId: number, employeeId: number | null): Promise<string>;
}
