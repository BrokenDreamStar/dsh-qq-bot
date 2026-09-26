/** withActionLogging / summarizeAction：出站 action 的日志记录策略。 */
import { describe, expect, it } from 'vitest';
import { withActionLogging, summarizeAction, renderSegmentsText } from './transportLog.ts';
import type { OneBotTransport, TransportStatus } from '../transport/base.ts';
import { MessageLogService } from './store.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeLog(): MessageLogService {
	const service = new MessageLogService({ logger, dataDir: '/tmp/unused' });
	service.reconfigure({ messageLog: true, messageLogMax: 100, messageLogToFile: false });
	return service;
}

/** 可编程假 transport：记录收到的 call，按脚本回值/抛错。 */
function fakeTransport(script: Map<string, unknown | Error>): { transport: OneBotTransport; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		transport: {
			kind: 'forward',
			connected: true,
			start: () => {},
			stop: () => {},
			async call(action) {
				calls.push(action);
				const outcome = script.get(action);
				if (outcome instanceof Error) throw outcome;
				return outcome;
			},
		},
	};
}

describe('renderSegmentsText', () => {
	it('渲染常见段并给媒体段占位符', () => {
		const text = renderSegmentsText([
			{ type: 'text', data: { text: '你好' } },
			{ type: 'image', data: { file: 'a.jpg' } },
			{ type: 'at', data: { qq: '42' } },
			{ type: 'reply', data: { id: '7' } },
		]);
		expect(text).toBe('你好[图片]@42[回复 7]');
	});

	it('渲染转发节点内容', () => {
		const text = renderSegmentsText([{ type: 'node', data: { content: [{ type: 'text', data: { text: '内文' } }] } }]);
		expect(text).toBe('内文');
	});
});

describe('summarizeAction', () => {
	it('send_msg 带目标与文本', () => {
		expect(summarizeAction('send_msg', { group_id: '123', message: [{ type: 'text', data: { text: '嗨' } }] })).toEqual({
			text: '群 123：嗨',
		});
		expect(summarizeAction('send_msg', { user_id: '42', message: [{ type: 'text', data: { text: '私聊' } }] })?.text).toBe('用户 42：私聊');
	});

	it('合并转发拼接各节点', () => {
		expect(
			summarizeAction('send_group_forward_msg', {
				group_id: '9',
				messages: [{ content: [{ type: 'text', data: { text: '第一段' } }] }, { content: [{ type: 'text', data: { text: '第二段' } }] }],
			})?.text,
		).toBe('群 9（合并转发）：第一段\n第二段');
	});

	it('撤回与请求处理', () => {
		expect(summarizeAction('delete_msg', { message_id: 7 })?.text).toBe('撤回消息 7');
		expect(summarizeAction('set_friend_add_request', { user_id: '42', approve: true })?.text).toBe('同意好友请求 42');
		expect(summarizeAction('set_group_add_request', { group_id: '9', user_id: '1', sub_type: 'add', approve: false })?.text).toContain('拒绝');
	});

	it('其它 action 返回 undefined（不记成功）', () => {
		expect(summarizeAction('get_image', { file: 'a' })).toBeUndefined();
		expect(summarizeAction('get_group_member_list', { group_id: '9' })).toBeUndefined();
	});
});

describe('withActionLogging', () => {
	it('消息类 action 成功后记录（含 message_id）', async () => {
		const { transport } = fakeTransport(new Map([['send_msg', { message_id: 77 }]]));
		const log = makeLog();
		const wrapped = withActionLogging(transport, log);
		await wrapped.call('send_msg', { user_id: '42', message: [{ type: 'text', data: { text: '答' } }] });
		const entries = log.recent();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.text).toBe('用户 42：答');
		expect(entries[0]!.dir).toBe('out');
		expect(entries[0]!.detail).toBe('message_id=77');
	});

	it('非消息类 action 成功不记录；失败记录 action-error', async () => {
		const { transport } = fakeTransport(new Map([['get_group_member_list', new Error('boom')]]));
		const log = makeLog();
		const wrapped = withActionLogging(transport, log);
		await expect(wrapped.call('get_group_member_list', { group_id: '9' })).rejects.toThrow('boom');
		expect(log.recent()).toHaveLength(1);
		expect(log.recent()[0]!.event).toBe('action-error');
		expect(log.recent()[0]!.detail).toContain('boom');
	});

	it('send_msg 失败同样记录 action-error', async () => {
		const { transport } = fakeTransport(new Map([['send_msg', new Error('retcode 1200')]]));
		const log = makeLog();
		await expect(withActionLogging(transport, log).call('send_msg', {})).rejects.toThrow('retcode 1200');
		expect(log.recent()[0]!.event).toBe('action-error');
	});

	it('心跳 get_version_info 永不记录', async () => {
		const { transport } = fakeTransport(new Map([['get_version_info', new Error('timeout')]]));
		const log = makeLog();
		await expect(withActionLogging(transport, log).call('get_version_info')).rejects.toThrow('timeout');
		expect(log.size).toBe(0);
	});

	it('透传 kind/connected/start/stop 与 onStatus 解耦', async () => {
		const { transport } = fakeTransport(new Map());
		const log = makeLog();
		const wrapped = withActionLogging(transport, log);
		let status: TransportStatus | undefined;
		expect(wrapped.kind).toBe('forward');
		expect(wrapped.connected).toBe(true);
		wrapped.start();
		wrapped.stop();
		expect(log.size).toBe(0);
		void status;
	});
});
