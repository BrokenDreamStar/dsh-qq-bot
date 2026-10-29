import { describe, expect, it } from 'vitest';
import { isMetaCommand, segmentText, stripQqNumbers, tokenizeQuery } from './text.ts';
import { scanSensitive } from './guard.ts';

describe('segmentText / tokenizeQuery', () => {
	it('中文按词切分，而不是整句一个 token', () => {
		expect(segmentText('张三说的备份方案还是用 restic 吧')).toBe('张三 说的 备份 方案 还是 用 restic 吧');
		expect(tokenizeQuery('restic 备份方案')).toEqual(['restic', '备份', '方案']);
	});

	it('中文查询词能在写入的索引串里找到', () => {
		const index = segmentText('备份还是用 restic 吧');
		expect(index).toContain('备份');
		expect(index).toContain('restic');
	});

	it('去掉 QQ 号但保留普通数字/版本号', () => {
		expect(stripQqNumbers('@张三(12345) 是运维')).toBe('@张三 是运维');
		expect(stripQqNumbers('版本 2.0 发布了')).toBe('版本 2.0 发布了');
	});
});

describe('isMetaCommand', () => {
	it('识别对机器人说的记忆指令', () => {
		for (const text of ['把刚才那条删了', '忘掉这个', '别记这个', '记住我说的', '不要提刚才的事']) {
			expect(isMetaCommand(text), text).toBe(true);
		}
	});

	it('不误伤真正的记忆请求', () => {
		expect(isMetaCommand('记住我喜欢简短回复')).toBe(false);
		expect(isMetaCommand('张三最近在折腾 NAS')).toBe(false);
	});
});

describe('scanSensitive', () => {
	it('手机号/证件号/银行卡/住址关键词命中', () => {
		expect(scanSensitive('手机号 13800138000').ok).toBe(false);
		expect(scanSensitive('身份证 110101199001011234').ok).toBe(false);
		expect(scanSensitive('我的家庭住址在……').ok).toBe(false);
	});

	it('普通群聊内容不命中', () => {
		expect(scanSensitive('回复要简短，不要表格').ok).toBe(true);
	});
});
