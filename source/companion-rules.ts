// The rules that keep the companion showing an agent's work, in one file for
// every route to the model: the MCP server's instructions, the launch flags
// below, and agy's rule file. resolve-agent-config.sh renders the same flags
// for sessions idow starts.

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {quoteLaunchValue} from './config-launch-flags.ts';
import {scriptsDir} from './runtime.ts';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = scriptsDir;
const RULES_PLACEHOLDER = '{rules}';
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_ARG_FLAGS = new Set([
	'-u',
	'--unset',
	'-C',
	'--chdir',
	'-S',
	'--split-string',
]);

/**
 * The underlying command token of an agent launch command after skipping leading
 * env assignments and `env` wrappers (e.g. `env FOO=1 /opt/agy` -> `/opt/agy`).
 */
export function unwrappedCommandWord(command: string): string | null {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (ENV_ASSIGNMENT.test(token)) {
			index++;
			continue;
		}

		if (path.posix.basename(token) === 'env') {
			index++;
			while (index < tokens.length) {
				const arg = tokens[index]!;
				if (ENV_ARG_FLAGS.has(arg)) {
					index += 2;
				} else if (arg.startsWith('-') || ENV_ASSIGNMENT.test(arg)) {
					index++;
				} else {
					break;
				}
			}

			continue;
		}

		return token;
	}

	return null;
}

export function isAgyCommand(command: string): boolean {
	const word = unwrappedCommandWord(command);
	return word !== null && path.posix.basename(word) === 'agy';
}

export function companionRules(): string {
	return fs
		.readFileSync(path.join(SCRIPTS_DIR, 'companion-rules.txt'), 'utf8')
		.trim();
}

/**
 * The rules flags from an agent's `rules_args`, with a leading space, or ''
 * for an agent that doesn't take the rules at launch. The rules go on one line
 * so a launch command stays one line in any shell.
 */
export function agentRulesFlags(rulesArgs: readonly string[]): string {
	if (rulesArgs.length === 0) return '';
	const rules = companionRules().replaceAll(/\s*\n\s*/g, ' ');
	return rulesArgs
		.map(
			word =>
				` ${quoteLaunchValue(word.replaceAll(RULES_PLACEHOLDER, () => rules))}`,
		)
		.join('');
}

export async function installAgentRules(
	command: string,
	worktreePath: string,
	options: {
		space?: string;
		repo?: string;
		role?: 'sous-chef' | 'worker';
	} = {},
): Promise<void> {
	if (!isAgyCommand(command)) return;
	await execFileAsync(path.join(SCRIPTS_DIR, 'install-agent-rules.sh'), [
		command,
		worktreePath,
		...(options.space ? ['--space', options.space] : []),
		...(options.repo ? ['--repo', options.repo] : []),
		...(options.role ? ['--role', options.role] : []),
	]);
}
