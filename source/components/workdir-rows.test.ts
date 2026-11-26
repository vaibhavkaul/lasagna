// What a work dir's rail adds to the rows the single-repo rail already
// draws: a repo tag before a space's key, and a header that says it folds.
import {test, expect} from 'bun:test';
import React from 'react';
import {render, until} from '../../test/helpers/render.ts';
import type {RailRow} from '../rail-groups.ts';
import type {SpaceData} from '../types.ts';
import {MAIN_SPACES_GROUP} from '../workdir-rail.ts';
import {railGroupHeaderText} from './RailGroupHeader.tsx';
import RepoPicker from './RepoPicker.tsx';
import SpaceListItem from './SpaceListItem.tsx';

const space: SpaceData = {
	name: 'tts-business:B2B-3184',
	repo: 'tts-business',
	key: 'B2B-3184',
	repoTag: 'tb',
	worktreePath: null,
	programStatus: {status: 'idle'},
	linearIssue: {
		identifier: 'B2B-3184',
		title: 'Biz remittance credit',
		state: {name: 'In Progress', type: 'started', color: '#4b9fea'},
	},
};

async function row(width: number, tag: string | undefined): Promise<string> {
	const view = await render(
		React.createElement(
			'box',
			{flexDirection: 'row', width},
			React.createElement(SpaceListItem, {
				space,
				isSelected: false,
				width,
				layout: 'single_line',
				label: space.key,
				tag,
			}),
		),
	);
	const frame = view.lastFrame() ?? '';
	await view.unmount();
	return frame;
}

test('a row shows its repo’s tag before the key, and the key in place of repo:KEY', async () => {
	const drawn = await row(50, 'tb');
	expect(drawn).toContain('● tb B2B-3184 Biz remittance credit');
	expect(drawn).not.toContain('tts-business:');
});

test('a row with no tag is drawn as it always was', async () => {
	expect(await row(50, undefined)).toContain(
		'● B2B-3184 Biz remittance credit',
	);
});

test('a rail too narrow for tag and key keeps the key', async () => {
	const drawn = await row(13, 'tb');
	expect(drawn).toContain('B2B-3184');
	expect(drawn).not.toContain('tb ');
});

test('a ticket space\u2019s row carries every repo\u2019s tag, and each repo\u2019s PR behind its tag', async () => {
	const ticket: SpaceData = {
		...space,
		name: '@work:B2B-3184',
		repo: '@work',
		repoTag: 'tb+as+te',
		ticketRepos: [
			{name: 'tts-business', tag: 'tb'},
			{name: 'appian-server', tag: 'as'},
			{name: 'terraform', tag: 'te'},
		],
		railStatus: {
			pipeline: 'failing',
			unresolvedCommentCount: 3,
			hasConflict: false,
			repos: [
				{
					repo: 'tts-business',
					status: {pipeline: 'passing', unresolvedCommentCount: 0},
				},
				{
					repo: 'appian-server',
					status: {pipeline: 'failing', unresolvedCommentCount: 3},
				},
				// No PR in terraform yet: nothing to show for it.
				{
					repo: 'terraform',
					status: {pipeline: null, unresolvedCommentCount: 0},
				},
			],
		},
	};
	const view = await render(
		React.createElement(
			'box',
			{flexDirection: 'row', width: 70},
			React.createElement(SpaceListItem, {
				space: ticket,
				isSelected: false,
				width: 70,
				layout: 'single_line',
				label: ticket.key,
				tag: ticket.repoTag,
			}),
		),
	);
	const drawn = view.lastFrame() ?? '';
	await view.unmount();
	expect(drawn).toContain('● tb+as+te B2B-3184 Biz remittance credit');
	expect(drawn).toMatch(/\(3\) tb✓ as✗ *$/m);
	expect(drawn).not.toContain('te✓');
});

const mains = (folded: boolean): Extract<RailRow, {kind: 'header'}> => ({
	kind: 'header',
	group: MAIN_SPACES_GROUP,
	count: 4,
	folded,
});

test('a header whose rows fold says which way it is', () => {
	expect(railGroupHeaderText(mains(false), 30, 'unicode')).toEqual({
		name: '▾ repos',
		count: ' (4)',
	});
	expect(railGroupHeaderText(mains(true), 30, 'unicode')).toEqual({
		name: '▸ repos',
		count: ' (4)',
	});
});

test('the repo picker lists the repos and picks by Enter or by number', async () => {
	const picked: string[][] = [];
	let cancelled = 0;
	const view = await render(
		React.createElement(RepoPicker, {
			repos: [
				{name: 'tts-business', share: 0.62, suggested: true},
				{name: 'data-eng', suggested: false},
				{name: 'terraform', suggested: false},
			],
			initialIndex: 1,
			prefix: 'B2B',
			onPick: (names: string[]) => picked.push(names),
			onCancel: () => cancelled++,
		}),
		{width: 70, height: 14},
	);
	const frame = view.lastFrame() ?? '';
	expect(frame).toContain('+ New Session in');
	// A repo the typed key's prefix is worked on in says how much of it.
	expect(frame).toContain('  1 [ ] tts-business  62% of B2B');
	// It opens on the repo it was told to.
	expect(frame).toContain('❯ 2 [ ] data-eng');
	await view.stdin.write('\r');
	await view.stdin.write('j');
	await view.stdin.write('\r');
	await view.stdin.write('1');
	expect(picked).toEqual([['data-eng'], ['terraform'], ['tts-business']]);
	// A lone Escape is only known for one once nothing follows it.
	await view.stdin.write('\u001B');
	await until(() => cancelled === 1);
	await view.unmount();
});

test('Space ticks repos, and Enter picks every ticked one for a ticket space', async () => {
	const picked: string[][] = [];
	const view = await render(
		React.createElement(RepoPicker, {
			repos: [
				{name: 'tts-business', suggested: true},
				{name: 'appian-server', suggested: true},
				{name: 'terraform', suggested: false},
			],
			initialIndex: 0,
			prefix: 'B2B',
			onPick: (names: string[]) => picked.push(names),
			onCancel() {},
		}),
		{width: 70, height: 14},
	);
	// Suggested by the repo's own config, which has no share to show.
	expect(view.lastFrame()).toContain('❯ 1 [ ] tts-business  ← B2B');
	await view.stdin.write(' ');
	await view.stdin.write('j');
	await view.stdin.write(' ');
	const frame = view.lastFrame() ?? '';
	expect(frame).toContain('+ New Ticket Space in');
	expect(frame).toContain('  1 [x] tts-business');
	expect(frame).toContain('❯ 2 [x] appian-server');
	expect(frame).toContain('  3 [ ] terraform');
	// The highlighted row is not picked for being highlighted.
	await view.stdin.write('j');
	await view.stdin.write('\r');
	expect(picked).toEqual([['tts-business', 'appian-server']]);
	// A digit still picks its row alone.
	await view.stdin.write('3');
	expect(picked[1]).toEqual(['terraform']);
	await view.unmount();
});
