import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { request, getProfiles } from '../wreq-js';

describe('HTTP', () => {
  before(() => {
    console.log('🔌 HTTP Test Suite\n');
  });

  test('should return available browser profiles', () => {
    const profiles = getProfiles();

    assert.ok(Array.isArray(profiles), 'Profiles should be an array');
    assert.ok(profiles.length > 0, 'Should have at least one profile');
    assert.ok(
      profiles.some((p) => p.includes('chrome')) ||
        profiles.some((p) => p.includes('firefox')) ||
        profiles.some((p) => p.includes('safari')),
      'Should include standard browser profiles'
    );

    console.log('Available profiles:', profiles.join(', '));
  });

  test('should make a simple GET request', async () => {
    const response = await request({
      url: 'https://httpbin.org/get',
      browser: 'chrome_131',
      timeout: 10000,
    });

    assert.ok(response.status >= 200 && response.status < 300, 'Should return successful status');
    assert.ok(Object.keys(response.headers).length > 0, 'Should have response headers');
    assert.ok(response.body.length > 0, 'Should have response body');

    const body = JSON.parse(response.body);

    assert.ok(body.headers['User-Agent'], 'Should have User-Agent header');

    console.log('Status:', response.status);
    console.log('User-Agent:', body.headers['User-Agent']);
  });

  test('should work with different browser profiles', async () => {
    const testUrl = 'https://httpbin.org/user-agent';
    const browsers = ['chrome_137', 'firefox_139', 'safari_18'];

    for (const browser of browsers) {
      const response = await request({
        url: testUrl,
        browser: browser as any,
        timeout: 10000,
      });

      assert.ok(response.status === 200, `${browser} should return status 200`);

      const data = JSON.parse(response.body);

      assert.ok(data['user-agent'], `${browser} should have user-agent`);

      console.log(`${browser}:`, data['user-agent'].substring(0, 70) + '...');
    }
  });

  test('should handle timeout errors', async () => {
    await assert.rejects(
      async () => {
        await request({
          url: 'https://httpbin.org/delay/10',
          browser: 'chrome_137',
          timeout: 1000, // 1 second timeout for 10 second delay
        });
      },
      {
        name: 'RequestError',
      },
      'Should throw an error on timeout'
    );
  });
});
