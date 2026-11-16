// Exercise the actual frontend client, with browser fetch/cookie handling mocked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(new URL('../../website/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../../website/src/lib/api.ts', import.meta.url), 'utf8');
async function client() {
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022,
  } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText + `\n// ${Math.random()}`).toString('base64'));
}

test('401 refreshes HttpOnly-cookie session once and replays multipart unchanged', async () => {
  const api = await client();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response('', { status: 401 }) :
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  };
  try {
    const formData = new FormData();
    formData.append('file', new Blob(['fixture']), 'test.zip');
    assert.deepEqual(await api.apiRequest('/api/v1/me/avatar', { method: 'POST', formData }), { ok: true });
    assert.equal(calls.length, 3);
    assert.ok(calls[1].url.endsWith('/api/v1/auth/refresh-token'));
    assert.equal(calls[0].options.body, formData);
    assert.equal(calls[2].options.body, formData);
    for (const call of calls) assert.equal(call.options.credentials, 'include');
  } finally { globalThis.fetch = original; }
});

test('login failures are not retried and backend envelope errors stay visible', async () => {
  const api = await client();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ code: 40101, msg: 'Invalid credentials' }), { status: 401 });
  };
  try {
    await assert.rejects(api.authApi.login({ identifier: 'fixture', password: 'fixture' }),
      error => error instanceof api.ApiError && error.httpStatus === 401 &&
        error.code === 40101 && error.message === 'Invalid credentials');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('failed refresh does not replay a non-idempotent request', async () => {
  const api = await client();
  const original = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async url => { paths.push(url); return new Response('', { status: 401 }); };
  try {
    await assert.rejects(api.apiRequest('/api/v1/submissions', { method: 'POST', body: { fixture: true } }),
      error => error instanceof api.ApiError && error.httpStatus === 401);
    assert.equal(paths.length, 2);
    assert.ok(paths[1].endsWith('/api/v1/auth/refresh-token'));
  } finally { globalThis.fetch = original; }
});
