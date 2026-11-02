/**
 * RAG 运行时安装器（主线程）。
 *
 * 设计：
 *  - 依赖装在 `<dataDir>/runtime/<manifestHash>/`，不写插件自己的 node_modules；
 *  - 模型缓存在 `<dataDir>/models/`，跨 runtime 版本共享；
 *  - 用 dsh 自带的 pnpm/node 安装，缓存目录也放在 runtime 下（避免用户全局
 *    npm 缓存权限问题）；
 *  - 安装失败不抛出：返回 `installed=false`，记忆继续 FTS-only。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Logger } from '../../types.ts';

/** 运行时依赖版本（升级时改这里，manifestHash 会变，旧目录保留可回滚）。 */
export const RAG_RUNTIME_VERSIONS = {
	'@huggingface/transformers': '4.3.2',
	'sqlite-vec': '0.1.9',
} as const;

export interface RuntimePaths {
	runtimeRoot: string;
	modelsDir: string;
	currentPath: string;
	lockPath: string;
	dir: string;
	nodeModules: string;
	manifestPath: string;
	installed: boolean;
}

export interface RuntimeProgress {
	kind: 'install' | 'download';
	message: string;
}

function safeNodeVersion(): string {
	return process.versions.node.split('.')[0] ?? '0';
}

/** 依赖清单 hash：平台/架构/Node 主版本/NAPI/依赖版本都参与。 */
export function runtimeManifestHash(): string {
	const input = [
		process.platform,
		process.arch,
		safeNodeVersion(),
		process.versions.napi ?? '',
		...Object.entries(RAG_RUNTIME_VERSIONS).map(([name, version]) => `${name}@${version}`),
	].join('|');
	return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

export function resolveRuntimePaths(dataDir: string): RuntimePaths {
	const runtimeRoot = join(dataDir, 'runtime');
	const dir = join(runtimeRoot, runtimeManifestHash());
	const manifestPath = join(dir, 'manifest.json');
	return {
		runtimeRoot,
		modelsDir: join(dataDir, 'models'),
		currentPath: join(runtimeRoot, 'current.json'),
		lockPath: join(runtimeRoot, '.install.lock'),
		dir,
		nodeModules: join(dir, 'node_modules'),
		manifestPath,
		installed: existsSync(manifestPath) && existsSync(join(dir, 'node_modules')),
	};
}

/** sqlite-vec 的 loadable extension 路径；没装返回 undefined。 */
export function resolveVecPath(runtimeDir: string): string | undefined {
	try {
		const require = createRequire(join(runtimeDir, 'package.json'));
		const mod = require('sqlite-vec') as { getLoadablePath?: () => string };
		return typeof mod.getLoadablePath === 'function' ? mod.getLoadablePath() : undefined;
	} catch {
		return undefined;
	}
}

function bundledPnpm(): { node: string; pnpm: string } | undefined {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	const base = join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies');
	const node = join(base, 'node', 'bin', 'node');
	const pnpm = join(base, 'pnpm', 'bin', 'pnpm.cjs');
	if (existsSync(node) && existsSync(pnpm)) return { node, pnpm };
	return undefined;
}

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{
	ok: boolean;
	stdout: string;
	stderr: string;
}> {
	return new Promise(resolve => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				// ignore
			}
		}, options.timeoutMs);
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.length > 20_000) stdout = stdout.slice(-20_000);
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
		});
		child.on('error', error => {
			clearTimeout(timer);
			resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}` });
		});
		child.on('exit', code => {
			clearTimeout(timer);
			resolve({ ok: code === 0, stdout, stderr });
		});
	});
}

/**
 * 确保 runtime 存在；不存在则安装。
 *
 * @returns 安装后的路径信息；`installed=false` 表示失败（调用方降级 FTS-only）。
 */
export async function ensureRuntime(options: {
	dataDir: string;
	logger: Logger;
	onProgress?: (progress: RuntimeProgress) => void;
}): Promise<RuntimePaths> {
	const paths = resolveRuntimePaths(options.dataDir);
	if (paths.installed) return paths;

	mkdirSync(paths.runtimeRoot, { recursive: true });
	mkdirSync(paths.modelsDir, { recursive: true });

	// 安装锁：防止两个 worker/进程同时装。
	if (existsSync(paths.lockPath)) {
		try {
			const raw = readFileSync(paths.lockPath, 'utf8');
			const lock = JSON.parse(raw) as { at?: number; pid?: number };
			const age = Date.now() - (lock.at ?? 0);
			if (age < 10 * 60_000) {
				options.logger.warn(`dsh-qq-bot: RAG runtime 正在被另一个进程安装（pid=${lock.pid ?? '?'}），本次跳过`);
				return paths;
			}
		} catch {
			// 坏锁视为陈旧
		}
	}
	try {
		writeFileSync(paths.lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
	} catch {
		// 锁写不了也继续；最坏是并发安装
	}

	const tmpDir = `${paths.dir}.tmp-${process.pid}`;
	try {
		rmSync(tmpDir, { recursive: true, force: true });
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(
			join(tmpDir, 'package.json'),
			JSON.stringify(
				{
					name: 'dsh-qq-bot-rag-runtime',
					private: true,
					dependencies: RAG_RUNTIME_VERSIONS,
				},
				null,
				2,
			),
			'utf8',
		);
		const cacheDir = join(tmpDir, '.cache');
		const env: NodeJS.ProcessEnv = {
			...process.env,
			npm_config_cache: cacheDir,
			PNPM_HOME: join(tmpDir, '.pnpm'),
			XDG_CACHE_HOME: cacheDir,
			CI: '1',
		};
		options.onProgress?.({ kind: 'install', message: '正在安装 RAG 运行时依赖…' });
		const pnpm = bundledPnpm();
		let result: { ok: boolean; stdout: string; stderr: string };
		const npmArgs = ['install', '--prefix', tmpDir, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'];
		if (pnpm !== undefined) {
			result = await run(
				pnpm.node,
				[pnpm.pnpm, '--dir', tmpDir, 'install', '--prod', '--ignore-workspace', '--ignore-scripts', '--reporter=append-only', '--store-dir', join(tmpDir, '.store')],
				{ cwd: tmpDir, env, timeoutMs: 15 * 60_000 },
			);
			if (!result.ok) {
				options.logger.warn(`dsh-qq-bot: pnpm 安装失败，改用 npm 重试：${(result.stderr || result.stdout).slice(-600)}`);
				result = await run('npm', npmArgs, { cwd: tmpDir, env, timeoutMs: 15 * 60_000 });
			}
		} else {
			result = await run('npm', npmArgs, { cwd: tmpDir, env, timeoutMs: 15 * 60_000 });
		}
		if (!result.ok) {
			options.logger.warn(
				`dsh-qq-bot: RAG runtime 安装失败，继续 FTS-only：${(result.stderr || result.stdout).slice(-1200)}`,
			);
			rmSync(tmpDir, { recursive: true, force: true });
			return { ...paths, installed: false };
		}
		writeFileSync(
			join(tmpDir, 'manifest.json'),
			JSON.stringify(
				{
					installedAt: Date.now(),
					platform: process.platform,
					arch: process.arch,
					node: process.versions.node,
					napi: process.versions.napi ?? '',
					versions: RAG_RUNTIME_VERSIONS,
				},
				null,
				2,
			),
			'utf8',
		);
		rmSync(paths.dir, { recursive: true, force: true });
		renameSync(tmpDir, paths.dir);
		try {
			writeFileSync(
				paths.currentPath,
				JSON.stringify({ dir: paths.dir, manifestHash: runtimeManifestHash(), at: Date.now() }, null, 2),
				'utf8',
			);
		} catch {
			// current.json 只是诊断用
		}
		options.logger.info(`dsh-qq-bot: RAG runtime 已安装到 ${paths.dir}`);
		return { ...paths, installed: true };
	} catch (error) {
		options.logger.warn(`dsh-qq-bot: RAG runtime 安装异常，继续 FTS-only：${error instanceof Error ? error.message : String(error)}`);
		rmSync(tmpDir, { recursive: true, force: true });
		return { ...paths, installed: false };
	} finally {
		try {
			rmSync(paths.lockPath, { force: true });
		} catch {
			// ignore
		}
	}
}
