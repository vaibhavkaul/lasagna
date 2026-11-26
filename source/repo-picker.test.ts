import {test, expect} from 'bun:test';
import {press} from '../test/helpers/key-press.ts';
import {
	defaultRepoIndex,
	repoPickerStep,
	repoPickerWindow,
} from './repo-picker.ts';

test('j, k and the arrows move within the list', () => {
	expect(repoPickerStep(press('j'), 0, 3)).toEqual({kind: 'move', index: 1});
	expect(repoPickerStep(press('down'), 1, 3)).toEqual({kind: 'move', index: 2});
	expect(repoPickerStep(press('down'), 2, 3)).toEqual({kind: 'move', index: 2});
	expect(repoPickerStep(press('k'), 2, 3)).toEqual({kind: 'move', index: 1});
	expect(repoPickerStep(press('up'), 0, 3)).toEqual({kind: 'move', index: 0});
});

test('Enter picks the highlighted repo and a digit picks its row', () => {
	expect(repoPickerStep(press('return'), 1, 3)).toEqual({
		kind: 'pick',
		index: 1,
	});
	expect(repoPickerStep(press('3'), 0, 3)).toEqual({kind: 'pick', index: 2});
	// A digit past the list picks nothing.
	expect(repoPickerStep(press('4'), 0, 3)).toEqual({kind: 'ignore'});
	expect(repoPickerStep(press('0'), 0, 3)).toEqual({kind: 'ignore'});
});

test('Escape and q leave without picking, and other keys do nothing', () => {
	expect(repoPickerStep(press('escape'), 1, 3)).toEqual({kind: 'cancel'});
	expect(repoPickerStep(press('q'), 1, 3)).toEqual({kind: 'cancel'});
	expect(repoPickerStep(press('x'), 1, 3)).toEqual({kind: 'ignore'});
	expect(repoPickerStep(press('return'), 0, 0)).toEqual({kind: 'ignore'});
	expect(repoPickerStep(press('escape'), 0, 0)).toEqual({kind: 'cancel'});
});

test('the list opens on the selected space\u2019s repo, else the last one used, else the first', () => {
	const repos = ['api', 'web', 'data'];
	expect(defaultRepoIndex(repos, 'web', 'data')).toBe(1);
	// The root main space is in no repo of the list.
	expect(defaultRepoIndex(repos, '@work', 'data')).toBe(2);
	expect(defaultRepoIndex(repos, undefined, undefined)).toBe(0);
	expect(defaultRepoIndex(repos, 'gone', 'gone-too')).toBe(0);
});

test('a list longer than its room keeps the highlighted row in view', () => {
	expect(repoPickerWindow(4, 0, 10)).toEqual({start: 0, end: 4});
	expect(repoPickerWindow(25, 0, 5)).toEqual({start: 0, end: 5});
	expect(repoPickerWindow(25, 12, 5)).toEqual({start: 10, end: 15});
	expect(repoPickerWindow(25, 24, 5)).toEqual({start: 20, end: 25});
	// A dialog with no room still shows the highlighted row.
	expect(repoPickerWindow(25, 7, 0)).toEqual({start: 7, end: 8});
});
