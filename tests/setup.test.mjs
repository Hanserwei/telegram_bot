import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramApi, pollIds, retryTelegramRead, TelegramRequestError } from '../scripts/telegram-api.mjs';

const secret = '123456:do-not-print-this-token';
const ok = result => Response.json({ ok: true, result });

test('polling resumes after a disconnect with the same offset and does not repeat IDs', async () => {
  const bodies = [], printed = [], warnings = [], delays = [];
  let count = 0;
  const api = createTelegramApi(secret, { fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    count++;
    if (count === 1) return ok([{ update_id: 8, message: { from: { id: 6007422252 } } }]);
    if (count === 2) throw new TypeError(`request failed ${secret}`, { cause: { code: 'ECONNRESET' } });
    return ok([{ update_id: 9, channel_post: { chat: { id: -1001234567890 } } }]);
  } });
  await pollIds(api, {
    print: value => printed.push(value), warn: value => warnings.push(value),
    sleep: async ms => delays.push(ms), shouldContinue: () => count < 3,
  });
  assert.deepEqual(bodies.map(body => body.offset), [0, 9, 9]);
  assert.equal(bodies[0].timeout, 15);
  assert.deepEqual(printed, ['用户 ID：6007422252', '频道 ID：-1001234567890']);
  assert.deepEqual(delays, [1000]);
  assert.match(warnings[0], /ECONNRESET/);
  assert.ok(!warnings[0].includes(secret));
});

for (const code of [401, 409]) {
  test(`${code} is reported specifically and is not retried`, async () => {
    let calls = 0;
    const api = createTelegramApi(secret, { fetchImpl: async () => {
      calls++;
      return Response.json({ ok: false, error_code: code, description: secret }, { status: code });
    } });
    await assert.rejects(retryTelegramRead(api, 'getUpdates', {}, {
      sleep: async () => assert.fail('must not retry'),
    }), error => error.message.includes(String(code)) && !error.message.includes(secret));
    assert.equal(calls, 1);
  });
}

test('respects Telegram retry_after instead of hammering a rate limit', async () => {
  const delays = [];
  let calls = 0;
  const api = createTelegramApi(secret, { fetchImpl: async () => ++calls === 1 ?
    Response.json({ ok: false, error_code: 429, parameters: { retry_after: 12 } }, { status: 429 }) : ok([]),
  });
  assert.deepEqual(await retryTelegramRead(api, 'getUpdates', {}, {
    sleep: async ms => delays.push(ms), warn: () => {},
  }), []);
  assert.deepEqual(delays, [12000]);
});

test('retries non-JSON gateway errors and caps exponential backoff', async () => {
  let calls = 0;
  const delays = [];
  const api = createTelegramApi(secret, { fetchImpl: async () => ++calls < 8 ?
    new Response('gateway error', { status: 502 }) : ok({ url: '' }),
  });
  await retryTelegramRead(api, 'getWebhookInfo', {}, {
    sleep: async ms => delays.push(ms), warn: () => {},
  });
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('empty successful polls keep the update offset and do not print false errors', async () => {
  let calls = 0;
  await pollIds(createTelegramApi(secret, { fetchImpl: async () => { calls++; return ok([]); } }), {
    shouldContinue: () => calls < 2, print: () => assert.fail('nothing to print'),
    warn: () => assert.fail('nothing to warn'), sleep: async () => assert.fail('no retry needed'),
  });
  assert.equal(calls, 2);
});

test('timeouts and unknown network errors never reveal raw messages or codes', async () => {
  for (const error of [new DOMException(secret, 'TimeoutError'),
    Object.assign(new Error(secret), { code: secret })]) {
    const api = createTelegramApi(secret, { fetchImpl: async () => { throw error; } });
    await assert.rejects(api('getUpdates'), error => error instanceof TelegramRequestError &&
      error.retryable && !error.message.includes(secret));
  }
});

test('malformed successful payloads are retriable but do not leak their body', async () => {
  const api = createTelegramApi(secret, { fetchImpl: async () => Response.json({ error: secret }) });
  await assert.rejects(api('getUpdates'), error => error.retryable && !error.message.includes(secret));
});

test('mutating requests cannot use the setup read retry wrapper', async () => {
  await assert.rejects(retryTelegramRead(() => assert.fail('must not send'), 'sendMessage'), /Only.*reads/);
});
