import { conversationId, messageId, roomId } from '@dramatis/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { adminProcessStore } from '../lib/admin-process-store';
import { AdminProcessDisclosure } from './AdminProcessDisclosure';

it('真实推理才显示思考，默认过程与工具详情收起且交接保持展开', () => {
  const scope = { db: {}, accountKey: 'a', roomId: roomId('r'), conversationId: conversationId('c') };
  adminProcessStore.begin(scope, 'run', Date.now());
  adminProcessStore.observe(scope, 'run', { type: 'request-start', requestIndex: 0 }, Date.now());
  const render = () => renderToString(createElement(AdminProcessDisclosure, { scope, runId: 'run' }));
  expect(render()).toContain('等待回复');
  expect(render()).not.toContain('思考内容');
  adminProcessStore.observe(scope, 'run', { type: 'reasoning', requestIndex: 0, delta: '实际返回的思考' }, Date.now());
  expect(render()).toContain('思考中');
  expect(render()).toContain('实际返回的思考');
  expect(render()).not.toContain(' open=""');
  adminProcessStore.setExpanded(scope, 'run', 'process', true);
  adminProcessStore.bindMessage(scope, 'run', messageId('saved'));
  expect(render()).toContain('open=""');
});

it('执行失败带草稿时显示未完成，不把摘要当成功', () => {
  const scope = { db: {}, accountKey: 'a', roomId: roomId('r'), conversationId: conversationId('c') };
  adminProcessStore.begin(scope, 'run', Date.now());
  adminProcessStore.observe(
    scope,
    'run',
    {
      type: 'tool-received',
      requestIndex: 0,
      toolIndex: 0,
      call: { id: 'c', type: 'function', function: { name: 'set_scene', arguments: '{"location":"露台"}' } },
    },
    Date.now(),
  );
  adminProcessStore.observe(
    scope,
    'run',
    {
      type: 'tool-end',
      requestIndex: 0,
      toolIndex: 0,
      execution: {
        callId: 'c',
        toolName: 'set_scene',
        draft: { kind: 'scene', patch: { location: '露台' }, summary: '设置露台' },
        ok: false,
        result: '磁盘失败',
      },
    },
    Date.now(),
  );
  adminProcessStore.update(scope, 'run', { phase: 'partial', endedAt: Date.now() });
  const html = renderToString(createElement(AdminProcessDisclosure, { scope, runId: 'run' }));
  expect(html).toContain('部分完成');
  expect(html).toContain('未完成');
  expect(html).toContain('磁盘失败');
  expect(html).not.toContain('场景已生效');
});
