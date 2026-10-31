import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSoul, inspectSoul, soulPath, writeSoulText } from './soul.ts';

let dir = '';

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'dshqq-soul-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('SOUL.md', () => {
	it('文件不存在时 inspect 回退模板但不写盘', () => {
		const info = inspectSoul(dir, '默认人格');
		expect(info).toMatchObject({ exists: false, source: 'template', text: '默认人格' });
		expect(existsSync(soulPath(dir))).toBe(false);
	});

	it('ensure 首次播种；已有文件绝不覆盖', () => {
		const first = ensureSoul(dir, '默认人格');
		expect(first.source).toBe('seeded');
		expect(readFileSync(soulPath(dir), 'utf8')).toBe('默认人格');
		const second = ensureSoul(dir, '新模板');
		expect(second).toMatchObject({ source: 'file', text: '默认人格' });
		expect(readFileSync(soulPath(dir), 'utf8')).toBe('默认人格');
	});

	it('空文件回退模板但不写盘', () => {
		writeFileSync(soulPath(dir), '   \n', 'utf8');
		const info = inspectSoul(dir, '默认人格');
		expect(info).toMatchObject({ exists: true, source: 'empty', text: '默认人格' });
		expect(readFileSync(soulPath(dir), 'utf8')).toBe('   \n');
	});

	it('writeSoulText 原子写入并返回路径', () => {
		const result = writeSoulText(dir, '自定义');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe(soulPath(dir));
		expect(readFileSync(soulPath(dir), 'utf8')).toBe('自定义');
	});
});
