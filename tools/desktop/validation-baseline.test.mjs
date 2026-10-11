import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../apps/web/node_modules/vite/dist/node/index.js';
import { withBaselineAdmin } from './validation-baseline.mjs';

test('actual git-blob baseline executes two production rounds and raw tool parsing with its own engine', async () => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
  });
  try {
    await withBaselineAdmin(async (entry) => {
      const baseline = await server.ssrLoadModule(entry);
      const { runFixture } = await server.ssrLoadModule('/apps/web/tests/quality/runner.ts');
      assert.equal(baseline.BASELINE_COMMIT, '4c5169a23ecc901ab892bae182f8f4ac78c4b8b8');
      let count = 0;
      const fixture = {
        family: 'admin',
        caseId: 'admin-3',
        source: 'git-blob-4c5169a-admin',
        input: {},
        request: { messages: [], tools: [] },
      };
      const config = {
        apiKey: 'FAKE-ONLY',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async (_url, init) => {
          count++;
          const wire = JSON.parse(init.body);
          if (count === 2) {
            assert.equal(
              wire.messages.find((message) => message.role === 'assistant').reasoning_content,
              'baseline fake chain',
            );
          }
          return Response.json({
            choices: [
              {
                message:
                  count === 1
                    ? {
                        reasoning_content: 'baseline fake chain',
                        tool_calls: [
                          {
                            id: 'baseline-call',
                            type: 'function',
                            function: { name: 'set_scene', arguments: '{"location":"北门"}' },
                          },
                        ],
                      }
                    : { content: '完成摘要' },
                finish_reason: count === 1 ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          });
        },
      };
      assert.equal((await runFixture(fixture, config)).error, 'baseline-engine-required');
      assert.equal(count, 0);
      const result = await runFixture(fixture, config, undefined, baseline);
      assert.equal(count, 2);
      assert.equal(result.error, null);
      assert.equal(result.admin.calls, 2);
      assert.equal(result.parse[0].ok, true);
      assert.equal(JSON.stringify(result).includes('baseline fake chain'), false);
      assert.equal(result.rounds[1].wireRedacted, true);
      assert.match(result.rounds[1].wire.messages.at(-1).content, /未写库/);
    });
  } finally {
    await server.close();
  }
});
