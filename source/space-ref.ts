// `repo:KEY`: a space named together with its repo. A bare KEY means the
// repo the command runs in, as it always has; the repo part is for naming a
// space of another repo in the same work dir, and for a command run at the
// work dir's root, which is in no repo.

export type SpaceRef = {
	/** Unset for a bare key. */
	repo?: string;
	key: string;
};

/** How a space is written with its repo. */
export function formatSpaceRef(repo: string, key: string): string {
	return `${repo}:${key}`;
}

/**
 * Split `repo:KEY`. Neither part holds a `:` (tmux reads one in a session
 * name as a window separator), so the first one divides them. Text with a
 * `/` in either part is something else, such as a URL, and stays one key.
 */
export function parseSpaceRef(raw: string): SpaceRef {
	const match = /^([^\s:/]+):([^\s:/]+)$/.exec(raw);
	return match ? {repo: match[1]!, key: match[2]!} : {key: raw};
}

export type SpaceRefResolution =
	/** The repo the command runs in answers, with this key. */
	| {kind: 'own'; key: string}
	/** A space of another repo. */
	| {kind: 'other'; repo: string; key: string}
	| {kind: 'unknown-repo'; repo: string; repos: string[]}
	| {kind: 'ambiguous'; key: string; matches: string[]}
	| {kind: 'not-found'; key: string; repos: string[]};

export type SpaceRefDeps = {
	/** The repo the command runs in; undefined when it runs in none. */
	ownRepo?: string;
	/** Every repo a space can be named in, the command's own included. */
	repos: readonly string[];
	/** Whether the repo has a space with this key, typed as the user typed it. */
	hasSpace: (repo: string, key: string) => boolean;
};

/**
 * Which repo a typed space belongs to. A `repo:KEY` names it. A bare key is
 * the command's own repo's when that repo has it, or runs in the only repo
 * there is. Otherwise it is the one other repo that has the key; with
 * several, the answer lists them so the user can pick one by name.
 */
export function resolveSpaceRef(
	raw: string,
	deps: SpaceRefDeps,
): SpaceRefResolution {
	const {ownRepo, repos} = deps;
	const ref = parseSpaceRef(raw);
	if (ref.repo !== undefined) {
		if (ref.repo === ownRepo) return {kind: 'own', key: ref.key};
		return repos.includes(ref.repo)
			? {kind: 'other', repo: ref.repo, key: ref.key}
			: {kind: 'unknown-repo', repo: ref.repo, repos: [...repos]};
	}

	const others = repos.filter(repo => repo !== ownRepo);
	if (
		ownRepo !== undefined &&
		(others.length === 0 || deps.hasSpace(ownRepo, raw))
	)
		return {kind: 'own', key: raw};
	const matches = others.filter(repo => deps.hasSpace(repo, raw));
	if (matches.length === 1) return {kind: 'other', repo: matches[0]!, key: raw};
	if (matches.length > 1)
		return {
			kind: 'ambiguous',
			key: raw,
			matches: matches.map(repo => formatSpaceRef(repo, raw)),
		};
	// Nothing has it: the command's own repo says so, as it does today.
	return ownRepo === undefined
		? {kind: 'not-found', key: raw, repos: [...repos]}
		: {kind: 'own', key: raw};
}

/** What the user is told when a space can't be placed in a repo. */
export function spaceRefError(
	resolution: Exclude<SpaceRefResolution, {kind: 'own'} | {kind: 'other'}>,
): string {
	switch (resolution.kind) {
		case 'unknown-repo': {
			return `No repo ${resolution.repo} in this work dir. Repos: ${resolution.repos.join(', ') || '(none)'}`;
		}

		case 'ambiguous': {
			return `${resolution.key} is a space in more than one repo. Name one: ${resolution.matches.join(', ')}`;
		}

		case 'not-found': {
			return `No space ${resolution.key} in any repo of this work dir (${resolution.repos.join(', ') || 'none'}). Name its repo as repo:KEY`;
		}
	}
}
