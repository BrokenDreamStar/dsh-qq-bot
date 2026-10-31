import { describe, expect, it } from 'vitest';
import { normalizeTaskDelivery, renderTaskTemplate, taskTemplateError } from './template.ts';

const noon = new Date(2026, 9, 31, 12, 0, 0);

describe('normalizeTaskDelivery', () => {
	it('只认 direct，其余（含旧任务的 undefined）都是 agent', () => {
		expect(normalizeTaskDelivery('direct')).toBe('direct');
		expect(normalizeTaskDelivery('agent')).toBe('agent');
		expect(normalizeTaskDelivery(undefined)).toBe('agent');
		expect(normalizeTaskDelivery('DIRECT')).toBe('agent');
	});
});

describe('taskTemplateError', () => {
	it('接受全部占位符与纯文本', () => {
		expect(taskTemplateError('起床啦')).toBeNull();
		expect(taskTemplateError('今天是原神开服第{daysSince:2020-09-15}天')).toBeNull();
		expect(taskTemplateError('{date} {time} {weekday}')).toBeNull();
	});

	it('拒绝未知占位符、带参数的日期类占位符与非法日期', () => {
		expect(taskTemplateError('今天是第{n}天')).toContain('{n}');
		expect(taskTemplateError('{date:YYYY}')).toContain('{date:YYYY}');
		expect(taskTemplateError('{daysSince:2020-9-15}')).toContain('{daysSince:2020-9-15}');
		expect(taskTemplateError('{daysSince:2020-02-30}')).toContain('{daysSince:2020-02-30}');
		expect(taskTemplateError('{daysSince}')).toContain('{daysSince}');
	});

	it('中文花括号与不含字母的正文不会被误判为占位符', () => {
		expect(taskTemplateError('进度{100%}，备注{第}')).toBeNull();
	});
});

describe('renderTaskTemplate', () => {
	it('按触发时刻渲染日期/时间/星期', () => {
		expect(renderTaskTemplate('{date} {time} {weekday}', noon)).toBe('2026-10-31 12:00 星期六');
	});

	it('daysSince 含起始日（起始日当天 = 第 1 天）', () => {
		expect(renderTaskTemplate('{daysSince:2020-09-15}', noon)).toBe('2238');
		expect(renderTaskTemplate('{daysSince:2026-10-31}', noon)).toBe('1');
		expect(renderTaskTemplate('{daysSince:2026-11-01}', noon)).toBe('0');
	});

	it('未知/非法占位符原样保留，不影响其余内容', () => {
		expect(renderTaskTemplate('{n} {daysSince:oops} {date}', noon)).toBe('{n} {daysSince:oops} 2026-10-31');
	});
});
