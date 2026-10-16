import { describe, expect, it } from 'vitest';
import { LoginRequestSchema } from '@/shared/contracts/auth/login.contract';
import { SignupRequestSchema } from '@/shared/contracts/enterprises/signup.contract';

/**
 * Login and signup validate a password DIFFERENTLY, and that difference is the
 * point of these tests rather than an inconsistency to be tidied away.
 */
describe('password validation is asymmetric by design', () => {
  const business = { name: 'Acme Coffee', email: 'hello@acme.test' };

  it('accepts a short password at LOGIN', () => {
    // Enforcing the strength policy here would leak the policy to an attacker
    // for free, and would lock out every account whose password predates it —
    // including internal accounts provisioned from configuration — behind a 422
    // that looks nothing like "wrong password". Whether it is correct is a
    // question for the hash.
    const parsed = LoginRequestSchema.parse({
      mobile: { number: '8408994828', countryCode: 'IN' },
      password: '1234',
    });
    expect(parsed.password).toBe('1234');
  });

  it('still requires a password to be present at login', () => {
    expect(() => LoginRequestSchema.parse({ email: 'a@b.test', password: '' })).toThrow();
  });

  it('rejects a short password at SIGNUP, where it is being CHOSEN', () => {
    expect(() =>
      SignupRequestSchema.parse({
        business,
        owner: { firstName: 'Priya', email: 'priya@acme.test', password: '1234' },
      }),
    ).toThrow();
  });

  it('accepts a long enough password at signup', () => {
    const parsed = SignupRequestSchema.parse({
      business,
      owner: { firstName: 'Priya', email: 'priya@acme.test', password: 'a-long-enough-password' },
    });
    expect(parsed.owner.password).toBe('a-long-enough-password');
  });

  it('does not trim a password: a trailing space is part of what was chosen', () => {
    const parsed = LoginRequestSchema.parse({ email: 'a@b.test', password: '  spaced  ' });
    expect(parsed.password).toBe('  spaced  ');
  });

  it('requires exactly one of email or mobile at login', () => {
    expect(() =>
      LoginRequestSchema.parse({
        email: 'a@b.test',
        mobile: { number: '8408994828', countryCode: 'IN' },
        password: 'a-long-enough-password',
      }),
    ).toThrow();
    expect(() => LoginRequestSchema.parse({ password: 'a-long-enough-password' })).toThrow();
  });
});
