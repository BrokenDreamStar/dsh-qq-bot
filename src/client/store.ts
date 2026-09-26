/**
 * 极简快照 store（dsh-client-store 的 createSnapshotStore 同形替代——
 * 该平台模块不发布独立类型，注入面只需要 getSnapshot/subscribe/set）。
 */
import type { SnapshotStore } from './types.ts';

export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
	let snapshot = initial;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => snapshot,
		set: (next) => {
			if (Object.is(next, snapshot)) return;
			snapshot = next;
			for (const listener of listeners) listener();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
