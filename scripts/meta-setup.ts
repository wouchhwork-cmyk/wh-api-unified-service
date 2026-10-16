/**
 * Prints exactly what to paste into the Meta App Dashboard.
 *
 *   node --env-file=.env.dev --import tsx scripts/meta-setup.ts
 *
 * Exists because the alternative is a human inventing a verify token, pasting it
 * into two places, and later wondering which environment got which. Ask the
 * service what its values are instead.
 */
import { loadConfiguration } from '../src/config/configuration';
import { resolveWebhookVerifyToken } from '../src/modules/connections/webhook-verify-token';

function main(): void {
  const { meta } = loadConfiguration();

  if (!meta.enabled) {
    console.log('META_ENABLED is false — set it to true, with FB_APP_ID, FB_APP_SECRET and');
    console.log('FB_LOGIN_CONFIG_ID, then run this again.\n');
  }

  const verifyToken = resolveWebhookVerifyToken(meta.webhookVerifyToken, meta.appSecret);
  const derived = !meta.webhookVerifyToken && verifyToken !== null;

  const callbackBase = meta.oauthRedirectUri.replace(
    /\/api\/v1\/connections\/meta\/callback\/?$/,
    '',
  );

  console.log('Meta App Dashboard → Facebook Login for Business → Settings');
  console.log('  Valid OAuth Redirect URIs:');
  console.log(`    ${meta.oauthRedirectUri || '(META_OAUTH_REDIRECT_URI is not set)'}`);
  console.log('');
  console.log('Meta App Dashboard → Webhooks → Page (and Instagram) → Edit subscription');
  console.log('  Callback URL:');
  console.log(
    `    ${callbackBase ? `${callbackBase}/api/v1/webhooks/meta` : '(set META_OAUTH_REDIRECT_URI first)'}`,
  );
  console.log('  Verify Token:');
  console.log(`    ${verifyToken ?? '(set FB_APP_SECRET, or META_WEBHOOK_VERIFY_TOKEN)'}`);
  console.log(
    derived
      ? '    ^ derived from FB_APP_SECRET — nothing to invent, and stable across restarts'
      : '    ^ from META_WEBHOOK_VERIFY_TOKEN',
  );
  console.log('  Subscribe to fields:');
  console.log('    messages, messaging_postbacks, feed, mention');
  console.log('');
  console.log('Only the OAuth Redirect URI is needed to connect a Page. Webhooks are what');
  console.log('put customer messages into the inbox, and can be set up later.');
}

main();
