// DeepSeek Harness, MIT (see THIRD_PARTY_NOTICES.md).
// Desktop 0.2.1-rc.5 compiled acquire method; browser-guests.ts and
// preload-browser.ts match rc.3, rc.4, rc.5 and 0.2.2-alpha.2 byte-for-byte.
// https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/apps/desktop/src/browser-guests.ts
class Guests {
  partitions = new Map(); leases = new Map();
  configureSession(value) { this.lastSession = value }
	acquire(owner, workspace) {
		if (typeof workspace !== "string" || workspace.length === 0 || workspace.length > 4096) throw new Error("desktop browser: a workspace storage identity is required");
		let partition = this.partitions.get(workspace);
		if (partition === void 0) {
			partition = `dsh-sidebar-browser-${randomUUID()}`;
			this.configureSession(session.fromPartition(partition));
			this.partitions.set(workspace, partition);
		}
		const lease = randomUUID();
		this.leases.set(lease, {
			owner,
			partition,
			attached: false
		});
		return {
			lease,
			partition
		};
	}
}
