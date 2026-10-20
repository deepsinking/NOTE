/** Lock permission follows the session's latest explicit toggle, not its conversation branch. */
export interface LockEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export function restoreLockState(
	entries: readonly LockEntry[],
	defaultLocked = false,
): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== "readonly-lock") continue;
		if (entry.data === null || typeof entry.data !== "object") continue;
		const value = (entry.data as { locked?: unknown }).locked;
		if (typeof value === "boolean") return value;
	}
	return defaultLocked;
}
