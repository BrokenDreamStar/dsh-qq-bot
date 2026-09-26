import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCwdArg, validateCwdDir } from './index.ts';

describe('resolveCwdArg', () => {
	it('~ 展开为主目录（网关模式）', () => {
		expect(resolveCwdArg('~', '/home/u')).toBe('/home/u');
		expect(resolveCwdArg('~/', '/home/u')).toBe('/home/u');
	});

	it('~/子路径 展开拼接', () => {
		expect(resolveCwdArg('~/projects/demo', '/home/u')).toBe(join('/home/u', 'projects/demo'));
	});

	it('绝对路径原样解析', () => {
		expect(resolveCwdArg('/opt/data', '/home/u')).toBe('/opt/data');
	});

	it('相对路径按进程 cwd 解析', () => {
		expect(resolveCwdArg('sub/dir', '/home/u')).toBe(join(process.cwd(), 'sub/dir'));
	});
});

describe('validateCwdDir', () => {
	it('存在的目录通过', () => {
		expect(validateCwdDir(mkdtempSync(join(tmpdir(), 'dsh-qq-cwd-')))).toBeNull();
	});

	it('不存在的路径报错', () => {
		expect(validateCwdDir(join(tmpdir(), `dsh-qq-cwd-not-exist-${Date.now()}`))).toContain('目录不存在');
	});

	it('文件不是目录', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-cwd-'));
		const file = join(dir, 'f.txt');
		writeFileSync(file, 'x', 'utf8');
		expect(validateCwdDir(file)).toContain('不是目录');
	});
});
