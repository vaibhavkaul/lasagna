// Issue tracker facade — thin wrapper over IssueTrackerProvider
// All exports preserved for backwards compatibility.
import {createIssueTracker, recordIssueTitles} from './providers/index.ts';
import type {TrackerIssue} from './providers/types.ts';
import {scopedSpace, spaceBareKey, spaceTracker} from './space-scope.ts';

// Re-export TrackerIssue as LinearIssue for callers that import from here
export type {TrackerIssue as LinearIssue} from './providers/types.ts';

// An issue is asked for by its space's name. In a process that shows one
// repo that is the issue key; in one that shows a work dir the name says
// which repo's tracker has the issue.

function tracker() {
	return createIssueTracker();
}

export async function getIssue(issueKey: string): Promise<TrackerIssue | null> {
	const scope = scopedSpace(issueKey);
	const key = scope?.key ?? issueKey;
	const issue = await spaceTracker(issueKey).getIssue(key);
	await recordIssueTitles([[key, issue]], scope?.repo.name);
	return issue;
}

export function getIssueCached(issueKey: string): TrackerIssue | null {
	return spaceTracker(issueKey).getIssueCached(spaceBareKey(issueKey));
}

export function getWorkflowStateColor(stateName: string): string | null {
	return tracker().getWorkflowStateColor(stateName);
}

export async function getIssues(
	issueKeys: string[],
): Promise<Map<string, TrackerIssue | null>> {
	const byRepo = new Map<string, Array<{name: string; key: string}>>();
	const own: string[] = [];
	for (const name of issueKeys) {
		const scope = scopedSpace(name);
		if (!scope) {
			own.push(name);
			continue;
		}

		const names = byRepo.get(scope.repo.name) ?? [];
		names.push({name, key: scope.key});
		byRepo.set(scope.repo.name, names);
	}

	if (byRepo.size === 0) {
		const issues = await tracker().getIssues(issueKeys);
		await recordIssueTitles(issues);
		return issues;
	}

	// Each repo's issues come from its own tracker, under their own keys.
	const result = new Map<string, TrackerIssue | null>();
	if (own.length > 0) {
		const issues = await tracker().getIssues(own);
		await recordIssueTitles(issues);
		for (const [key, issue] of issues) result.set(key, issue);
	}

	await Promise.all(
		[...byRepo].map(async ([repo, names]) => {
			const issues = await spaceTracker(names[0]!.name).getIssues(
				names.map(({key}) => key),
			);
			await recordIssueTitles(issues, repo);
			for (const {name, key} of names)
				if (issues.has(key)) result.set(name, issues.get(key) ?? null);
		}),
	);
	return result;
}

export async function searchAssignedIssues(
	assignee: string | undefined,
	statuses: string[],
): Promise<TrackerIssue[]> {
	return tracker().searchAssignedIssues(assignee, statuses);
}

export function clearCache(): void {
	tracker().clearCache();
}

/** Claim an issue, for trackers that support it. */
export async function claimIssue(issueKey: string): Promise<boolean> {
	try {
		const provider = spaceTracker(issueKey);
		if (!provider.claimIssue) return false;
		return await provider.claimIssue(spaceBareKey(issueKey));
	} catch {
		return false;
	}
}
