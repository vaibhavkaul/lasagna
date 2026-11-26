// The new-space dialog on a rail that shows a whole work dir: the repo a
// space is made in follows the issue key typed, and Tab lists them all.
import {test, expect} from 'bun:test';
import React from 'react';
import {render, until} from '../../test/helpers/render.ts';
import {teardown} from '../../test/helpers/teardown.ts';
import {listRepos, workdirFixture} from '../../test/helpers/workdir-fixture.ts';
import {issueTrackerFor, setRepoProviderSources} from '../providers/index.ts';
import {repoContext} from '../repo-context.ts';
import {repoChoices} from '../repo-picker.ts';
import {parseScanSuggestions} from '../scan-suggestions.ts';
import PromptDialog from './PromptDialog.tsx';

const profiles = (name: string) =>
	`version: 1\nprofiles:\n  ${name}:\n    display_name: ${name}\n`;

type Repo = {name: string; root: string};

/** A work dir of three repos, each with a profile of its own, and its scan. */
function workdir() {
	const fixture = workdirFixture({
		repos: {
			api: {'.pappardelle.yml': profiles('api-profile')},
			web: {'.pappardelle.yml': profiles('web-profile')},
			data: {'.pappardelle.yml': profiles('data-profile')},
		},
		workdirConfig: listRepos,
	});
	const {api, web, data} = fixture.repos as Record<
		'api' | 'web' | 'data',
		Repo
	>;
	const suggestions = parseScanSuggestions(
		JSON.stringify({
			version: 1,
			prefixes: {
				B2B: {
					defaultRepo: web.name,
					repos: {[web.name]: 0.6, [api.name]: 0.4},
				},
				DATA: {defaultRepo: data.name, repos: {[data.name]: 1}},
			},
		}),
	);
	return {api, web, data, suggestions, all: [api, web, data]};
}

type Submission = {input: string; profile: string | null; repos?: string[]};

/** The ready work a repo's tracker lists, as a tracker that can list it does. */
type Ready = Partial<Record<'api' | 'web' | 'data', string[]>>;

async function renderDialog(last?: 'api' | 'web' | 'data', ready: Ready = {}) {
	const repos = workdir();
	for (const [label, identifiers] of Object.entries(ready)) {
		const {name} = repos[label as keyof Ready];
		setRepoProviderSources(name, {});
		issueTrackerFor(name).listReadyIssues = async () =>
			identifiers.map(identifier => ({
				identifier,
				title: `Ready ${identifier}`,
				state: {name: 'Open', type: 'unstarted', color: '#00ff00'},
			}));
	}

	const {suggestions, all} = repos;
	const names = all.map(repo => repo.name);
	const lastUsed = last === undefined ? undefined : repos[last].name;
	const submitted: Submission[] = [];
	const view = await render(
		React.createElement(PromptDialog, {
			onSubmit(input, profile, _isKey, _agent, repos) {
				submitted.push({input, profile, repos});
			},
			onCancel() {},
			availableWidth: 90,
			isInTmux: false,
			repos: {
				choicesFor: (input: string) =>
					repoChoices({repos: names, input, suggestions, lastUsed}),
				contextOf: (name: string) =>
					repoContext(all.find(repo => repo.name === name)!.root),
			},
		}),
		{width: 90, height: 30},
	);
	teardown(async () => view.unmount());
	const shows = async (text: string) =>
		until(
			() => (view.lastFrame() ?? '').includes(text),
			() => view.lastFrame(),
		);
	return {...repos, view, submitted, shows};
}

test('the dialog opens on the last repo used and says Tab lists the repos', async () => {
	const {view, shows, data} = await renderDialog('data');
	await shows(`+ New Session in ${data.name}`);
	expect(view.lastFrame()).toContain('Tab for repos');
	// Its profiles are that repo's.
	expect(view.lastFrame()).toContain('data-profile');
});

test('an issue key moves the dialog to the repo its prefix defaults to', async () => {
	const {view, shows, api, data} = await renderDialog('api');
	await shows(`+ New Session in ${api.name}`);
	await view.stdin.write('DATA-41');
	await shows(`+ New Session in ${data.name}`);
	expect(view.lastFrame()).not.toContain(api.name);
});

test('Enter on a key worked on in one repo starts it there without asking', async () => {
	const {view, submitted, data} = await renderDialog('api');
	await view.stdin.write('DATA-41');
	await view.stdin.write('\r');
	await until(() => submitted.length === 1);
	expect(submitted[0]).toEqual({
		input: 'DATA-41',
		profile: null,
		repos: [data.name],
	});
});

test('Enter on a key worked on in several repos asks which, on its default repo', async () => {
	const {view, submitted, shows, api, web, data} = await renderDialog('data');
	await view.stdin.write('B2B-3184');
	await shows(`+ New Session in ${web.name}`);
	await view.stdin.write('\r');
	await shows(`❯ 1 [ ] ${web.name}  60% of B2B`);
	const picker = view.lastFrame() ?? '';
	expect(picker).toContain(`  2 [ ] ${api.name}  40% of B2B`);
	expect(picker).toContain(`  3 [ ] ${data.name}`);
	expect(submitted).toEqual([]);
	// Enter confirms the suggestion and carries on to the start.
	await view.stdin.write('\r');
	await until(() => submitted.length === 1);
	expect(submitted[0]).toEqual({
		input: 'B2B-3184',
		profile: null,
		repos: [web.name],
	});
});

test('picking another repo in the list starts the space there', async () => {
	const {view, submitted, shows, api} = await renderDialog();
	await view.stdin.write('B2B-3184');
	await view.stdin.write('\r');
	await shows('60% of B2B');
	await view.stdin.write('j');
	await view.stdin.write('\r');
	await until(() => submitted.length === 1);
	expect(submitted[0]!.repos).toEqual([api.name]);
});

test('Tab lists the repos for free text, and the pick stays while typing goes on', async () => {
	const {view, submitted, shows, api, data} = await renderDialog('api');
	await view.stdin.write('fix the login');
	await view.stdin.write('\t');
	await shows(`❯ 1 [ ] ${api.name}`);
	await view.stdin.write('3');
	await shows(`+ New Session in ${data.name}`);
	// Back in the prompt, with what was typed.
	expect(view.lastFrame()).toContain('> fix the login');
	await view.stdin.write(' page');
	await shows('> fix the login page');
	expect(view.lastFrame()).toContain(`+ New Session in ${data.name}`);
	// Free text goes through the profile list: Enter there starts it.
	await view.stdin.write('\r');
	await view.stdin.write('\r');
	await until(() => submitted.length === 1);
	expect(submitted[0]).toEqual({
		input: 'fix the login page',
		// The work dir's own profile leads the repo's list.
		profile: 't',
		repos: [data.name],
	});
});

test('Escape in the list goes back to the prompt and changes nothing', async () => {
	const {view, shows, api} = await renderDialog('api');
	await view.stdin.write('\t');
	await shows(`❯ 1 [ ] ${api.name}`);
	await view.stdin.write('j');
	await view.stdin.write('\u001B');
	await shows(`+ New Session in ${api.name}`);
	expect(view.lastFrame()).toContain('Tab for repos');
});

test('ticking two repos makes it a ticket space in both', async () => {
	const {view, submitted, shows, api, web} = await renderDialog();
	await view.stdin.write('B2B-3184');
	await view.stdin.write('\t');
	await shows('60% of B2B');
	await view.stdin.write(' ');
	await view.stdin.write('j');
	await view.stdin.write(' ');
	await view.stdin.write('\r');
	await shows(`+ New Ticket Space in ${web.name} + ${api.name}`);
	await view.stdin.write('\r');
	await until(() => submitted.length === 1);
	expect(submitted[0]!.repos).toEqual([web.name, api.name]);
});

test('a ready row moves the dialog to the repo its key belongs in, as a typed key does', async () => {
	const {view, submitted, shows, api, data} = await renderDialog('api', {
		api: ['DATA-7'],
	});
	await shows('DATA-7 Ready DATA-7');
	expect(view.lastFrame()).toContain(`+ New Session in ${api.name}`);
	await view.stdin.write('\u001B[B');
	await shows(`+ New Session in ${data.name}`);
	// The list is still the tracker's, with the cursor on its row.
	expect(view.lastFrame()).toContain('❯ DATA-7 Ready DATA-7');
	await view.stdin.write('\r');
	await until(() => submitted.length === 1);
	expect(submitted[0]).toEqual({
		input: 'DATA-7',
		profile: null,
		repos: [data.name],
	});
});

test('Enter on a ready row whose key is worked on in several repos asks which', async () => {
	const {view, submitted, shows, api, web} = await renderDialog('api', {
		api: ['B2B-9'],
	});
	await shows('B2B-9 Ready B2B-9');
	await view.stdin.write('\u001B[B');
	await shows(`+ New Session in ${web.name}`);
	await view.stdin.write('\r');
	await shows(`❯ 1 [ ] ${web.name}  60% of B2B`);
	expect(submitted).toEqual([]);
	// The other repo it is worked on in is the one whose tracker listed it.
	await view.stdin.write('j');
	await view.stdin.write('\r');
	await until(() => submitted.length === 1);
	expect(submitted[0]).toEqual({
		input: 'B2B-9',
		profile: null,
		repos: [api.name],
	});
});

test('a ready row whose prefix nothing knows stays in the repo whose tracker listed it', async () => {
	const {view, submitted, shows, data} = await renderDialog('api', {
		data: ['misc-12'],
	});
	// The typed key moves the dialog, and the list, to its repo.
	await view.stdin.write('DATA-41');
	await shows('misc-12 Ready misc-12');
	await view.stdin.write('\u001B[B');
	await shows('❯ misc-12');
	expect(view.lastFrame()).toContain(`+ New Session in ${data.name}`);
	await view.stdin.write('\r');
	await until(() => submitted.length === 1);
	expect(submitted[0]).toEqual({
		input: 'misc-12',
		profile: null,
		repos: [data.name],
	});
});
