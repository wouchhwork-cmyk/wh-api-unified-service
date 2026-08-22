import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  createTestApp,
  platformAdminLogin,
  provisionPlatformAdmin,
  resetTenantData,
  type TestApp,
} from './app.harness';

const SIGNUP = {
  business: { name: 'Blue Bottle Cafe', email: 'hello@bluebottle.test' },
  owner: {
    firstName: 'Meera',
    email: 'meera@bluebottle.test',
    password: 'a-long-enough-password',
  },
};

/**
 * The Meta connect flow, as far as it can go without a real Facebook app.
 *
 * Everything up to the token exchange is ours and testable: who may start a
 * connection, what the authorization URL contains, and every way the callback can
 * fail. The exchange itself needs real credentials, so these run against the fake
 * but well-formed ones in .env.local — which is enough, because the assertions
 * are about OUR behaviour on the way in and the way back.
 */
describe('connecting a Meta account', () => {
  let testApp: TestApp;
  let app: NestExpressApplication;
  let db: DataSource;

  beforeAll(async () => {
    testApp = await createTestApp();
    app = testApp.app;
    db = testApp.db;
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(async () => {
    await resetTenantData(db);
    await db.query(`DELETE FROM oauth_states`);
    await provisionPlatformAdmin(app);
  });

  const http = () => request(app.getHttpServer());
  const code = (): string => process.env.OTP_STATIC_CODE ?? '666666';

  async function adminToken(): Promise<string> {
    const login = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    return login.body.data.accessToken as string;
  }

  /** Signs up, verifies, and optionally activates. */
  async function business(activate = true): Promise<{ token: string; refId: string }> {
    const signup = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: signup.body.data.verificationRefId, code: code() })
      .expect(200);

    if (activate) {
      await http()
        .post(`/api/v1/platform/enterprises/${signup.body.data.enterpriseRefId}/status`)
        .set('Authorization', `Bearer ${await adminToken()}`)
        .send({ status: 'active' })
        .expect(200);
    }

    return {
      token: verified.body.data.accessToken as string,
      refId: signup.body.data.enterpriseRefId as string,
    };
  }

  function stateFrom(authorizationUrl: string): string {
    const state = new URL(authorizationUrl).searchParams.get('state');
    if (!state) throw new Error('the authorization URL carried no state');
    return state;
  }

  it('refuses to start a connection without a token', async () => {
    const response = await http()
      .post('/api/v1/connections/start')
      .send({ provider: 'meta' })
      .expect(401);
    expect(response.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('tells a client which platforms it can offer', async () => {
    const { token } = await business();
    const response = await http()
      .get('/api/v1/connections/providers')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Only what is implemented — a client should not have to hardcode this, and
    // should not be shown a platform that would answer 501.
    expect(response.body.data).toEqual([{ provider: 'meta', label: 'Facebook & Instagram' }]);
  });

  it('rejects a provider that is not a platform, and one that is not built yet', async () => {
    const { token } = await business();

    // Not a platform at all: the caller's mistake.
    const nonsense = await http()
      .post('/api/v1/connections/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'myspace' })
      .expect(422);
    expect(nonsense.body.error.code).toBe('VALIDATION_FAILED');

    // A platform we recognise and have not built: OUR gap, and a different
    // answer, so a client can say "coming soon" rather than "you sent nonsense".
    const notBuilt = await http()
      .post('/api/v1/connections/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'google' })
      .expect(501);
    expect(notBuilt.body.error.code).toBe('PROVIDER_NOT_SUPPORTED');
    expect(notBuilt.body.error.details[0].issue).toContain('meta');

    // Unknown extra fields are refused, like every other endpoint here.
    await http()
      .post('/api/v1/connections/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'meta', enterpriseId: 999 })
      .expect(422);
  });

  it('refuses to start a connection for a business that is not activated', async () => {
    const { token } = await business(false);
    const response = await http()
      .post('/api/v1/connections/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'meta' })
      .expect(403);
    expect(response.body.error.code).toBe('ENTERPRISE_PENDING_ACTIVATION');
  });

  it('builds a Login for Business URL, with no scope list', async () => {
    const { token } = await business();
    const response = await http()
      .post('/api/v1/connections/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'meta' })
      .expect(200);

    const url = new URL(response.body.data.authorizationUrl as string);
    expect(url.host).toBe('www.facebook.com');
    expect(url.pathname).toContain('/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBeTruthy();
    // config_id is what makes this Login for Business: the configuration decides
    // the scopes, so sending a scope list too would be wrong.
    expect(url.searchParams.get('config_id')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toContain('/connections/meta/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('records the state so it can be spent once', async () => {
    const { token } = await business();
    await http()
      .post('/api/v1/connections/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'meta' })
      .expect(200);

    const rows: { count: string }[] = await db.query(
      `SELECT count(*) AS count FROM oauth_states WHERE consumed_at IS NULL`,
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('redirects rather than returning JSON when the callback has no code', async () => {
    // A human is looking at this URL, so every outcome is a redirect.
    const response = await http().get('/api/v1/connections/meta/callback').expect(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('status')).toBe('error');
    expect(location.searchParams.get('reason')).toBe('missing_code_or_state');
  });

  it('reports a cancelled consent screen as cancelled, not as an error', async () => {
    const response = await http()
      .get('/api/v1/connections/meta/callback?error=access_denied&error_description=User+said+no')
      .expect(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('status')).toBe('cancelled');
  });

  it('refuses a forged state', async () => {
    const response = await http()
      .get('/api/v1/connections/meta/callback?code=FAKE&state=not.a.real.state')
      .expect(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('reason')).toBe('OAUTH_STATE_INVALID');
  });

  it('spends the state exactly once, so the callback URL cannot be replayed', async () => {
    const { token } = await business();
    const start = await http()
      .post('/api/v1/connections/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'meta' })
      .expect(200);
    const state = stateFrom(start.body.data.authorizationUrl as string);

    // First time through: the state is spent, then the exchange fails because
    // the credentials are fake. That failure is the proof it got past the state.
    const first = await http()
      .get(`/api/v1/connections/meta/callback?code=FAKE&state=${encodeURIComponent(state)}`)
      .expect(302);
    expect(new URL(first.headers.location as string).searchParams.get('reason')).not.toBe(
      'OAUTH_STATE_INVALID',
    );

    /*
     * The replay. This URL sits in browser history, in logs and in a Referer
     * header, so it WILL be seen again — and it must not work a second time.
     */
    const replay = await http()
      .get(`/api/v1/connections/meta/callback?code=FAKE&state=${encodeURIComponent(state)}`)
      .expect(302);
    expect(new URL(replay.headers.location as string).searchParams.get('reason')).toBe(
      'OAUTH_STATE_INVALID',
    );
  });

  it('refuses to complete a connection for a business suspended mid-flow', async () => {
    const { token, refId } = await business();
    const start = await http()
      .post('/api/v1/connections/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'meta' })
      .expect(200);
    const state = stateFrom(start.body.data.authorizationUrl as string);

    // Switched off AFTER the state was minted. The callback is @Public and
    // bypasses the guard chain, so it has to check this itself.
    await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set('Authorization', `Bearer ${await adminToken()}`)
      .send({ status: 'suspended', reason: 'mid-flow' })
      .expect(200);

    const response = await http()
      .get(`/api/v1/connections/meta/callback?code=FAKE&state=${encodeURIComponent(state)}`)
      .expect(302);
    expect(new URL(response.headers.location as string).searchParams.get('reason')).toBe(
      'ENTERPRISE_SUSPENDED',
    );
  });

  it('lists connections and channels, empty and permission-gated', async () => {
    const { token } = await business();

    const connections = await http()
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(connections.body.data).toEqual([]);

    const channels = await http()
      .get('/api/v1/connections/channels')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(channels.body.data).toEqual([]);

    await http().get('/api/v1/connections').expect(401);
  });

  it('gives an agent no authority to connect an account', async () => {
    const { token } = await business();

    const roles = await http()
      .get('/api/v1/employees/roles')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const agentRole = (roles.body.data as { refId: string; name: string }[]).find(
      (role) => role.name === 'agent',
    );

    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Rahul', email: 'rahul@bluebottle.test', roleRefId: agentRole?.refId })
      .expect(201);
    const accepted = await http()
      .post('/api/v1/auth/accept-invite')
      .send({
        email: 'rahul@bluebottle.test',
        code: code(),
        password: 'a-password-only-rahul-knows',
      })
      .expect(200);

    // An agent answers messages; connecting the business's accounts is not
    // theirs to do.
    const refused = await http()
      .post('/api/v1/connections/start')
      .set('Authorization', `Bearer ${accepted.body.data.accessToken}`)
      .send({ provider: 'meta' })
      .expect(403);
    expect(refused.body.error.code).toBe('PERMISSION_DENIED');
  });
});
