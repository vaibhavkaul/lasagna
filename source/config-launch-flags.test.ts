import test from 'ava';
import {
	bindResumeArgs,
	isAgyAgentProfile,
	isClaudeCommand,
	renderAgentLaunchFlags,
	renderAgentPrompt,
	supportsSousChefPrompt,
} from './config-launch-flags.ts';

// ============================================================================
// getAgentProfile — resolution
// ============================================================================

const codexResume = {resumeArgs: 'resume {session_id}', isClaude: false};

const claudeResume = {resumeArgs: '--resume {session_id}', isClaude: true};

test('bindResumeArgs fills the recorded session id', t => {
	t.is(bindResumeArgs(codexResume, 'abc-123'), 'resume abc-123');
	t.is(bindResumeArgs(claudeResume, 'abc-123'), '--resume abc-123');
});

test('bindResumeArgs drops the resume attempt without a recorded id', t => {
	t.is(bindResumeArgs(codexResume, undefined), undefined);
	t.is(bindResumeArgs(codexResume, ''), undefined);
});

test('bindResumeArgs falls back to --continue for claude without a recorded id', t => {
	t.is(bindResumeArgs(claudeResume, undefined), '--continue');
});

test('bindResumeArgs keeps claude flags around the resume when no id was recorded', t => {
	const resume = (resumeArgs: string) =>
		bindResumeArgs({resumeArgs, isClaude: true}, undefined);
	t.is(
		resume('--resume {session_id} --fork-session'),
		'--continue --fork-session',
	);
	t.is(
		resume('--fork-session --resume={session_id}'),
		'--fork-session --continue',
	);
	t.is(resume('-r {session_id} --fork-session'), '--continue --fork-session');
	// A spelling it can't map still resumes the directory's conversation.
	t.is(resume('--from {session_id} --fork-session'), '--continue');
});

test('bindResumeArgs rejects an id that is unsafe to put in a shell command', t => {
	t.is(bindResumeArgs(codexResume, 'x; rm -rf ~'), undefined);
	t.is(bindResumeArgs(codexResume, '--yolo'), undefined);
	t.is(
		bindResumeArgs(claudeResume, '--dangerously-skip-permissions'),
		'--continue',
	);
});

test('bindResumeArgs leaves resume args without the placeholder alone', t => {
	t.is(
		bindResumeArgs({resumeArgs: 'resume --last', isClaude: false}, undefined),
		'resume --last',
	);
	t.is(
		bindResumeArgs({resumeArgs: undefined, isClaude: true}, 'abc'),
		undefined,
	);
});

// ============================================================================
// Agent profiles — model and effort
// ============================================================================

test('renderAgentLaunchFlags quotes values that are not bare tokens', t => {
	const codex = {
		modelArgs: '-m {model}',
		effortArgs: '-c model_reasoning_effort={effort}',
	};
	t.is(
		renderAgentLaunchFlags({...codex, model: 'gpt-5.5', effort: 'high'}),
		' -m gpt-5.5 -c model_reasoning_effort=high',
	);
	t.is(
		renderAgentLaunchFlags({
			modelArgs: '--model={model}',
			model: "it's claude-opus-5[1m]",
		}),
		` --model='it'\\''s claude-opus-5[1m]'`,
	);
});

test('renderAgentLaunchFlags inserts $ sequences in a value literally', t => {
	t.is(
		renderAgentLaunchFlags({modelArgs: '--model {model}', model: 'foo$'}),
		` --model 'foo$'`,
	);
	t.is(
		renderAgentLaunchFlags({modelArgs: '--model {model}', model: 'a$&b'}),
		` --model 'a$&b'`,
	);
});

test('renderAgentLaunchFlags passes no flag without a value or a template', t => {
	t.is(renderAgentLaunchFlags({modelArgs: '-m {model}', model: ''}), '');
	t.is(renderAgentLaunchFlags({model: 'gpt-5.5', effort: 'high'}), '');
	t.is(renderAgentLaunchFlags({modeArgs: '--mode {mode}', mode: ''}), '');
	t.is(renderAgentLaunchFlags({mode: 'plan'}), '');
});

test('renderAgentLaunchFlags renders mode through modeArgs after model and effort', t => {
	t.is(
		renderAgentLaunchFlags({
			modelArgs: '--model {model}',
			effortArgs: '--effort {effort}',
			modeArgs: '--mode {mode}',
			model: 'gemini-4-hydrogen',
			effort: 'high',
			mode: 'plan',
		}),
		' --model gemini-4-hydrogen --effort high --mode plan',
	);
	t.is(
		renderAgentLaunchFlags({
			modeArgs: '--mode={mode}',
			mode: 'a b',
		}),
		` --mode='a b'`,
	);
});

test('renderAgentPrompt wraps prompt in promptArgs when present and quotes for the shell', t => {
	t.is(renderAgentPrompt('/sous-chef'), ` '/sous-chef'`);
	t.is(renderAgentPrompt('/sous-chef', ''), ` '/sous-chef'`);
	t.is(renderAgentPrompt('/sous-chef', '-i {prompt}'), ` -i '/sous-chef'`);
	t.is(renderAgentPrompt('$sous-chef'), ` '$sous-chef'`);
	t.is(renderAgentPrompt("a'b", '--prompt={prompt}'), ` --prompt='a'\\''b'`);
});

test('isClaudeCommand matches bare names and paths, not wrappers', t => {
	t.true(isClaudeCommand('claude'));
	t.true(isClaudeCommand('/usr/local/bin/claude'));
	t.true(isClaudeCommand('claude --some-flag'));
	t.false(isClaudeCommand('codex'));
	t.false(isClaudeCommand('claude-local'));
	t.false(isClaudeCommand('my-claude-wrapper'));
});

test('isAgyAgentProfile matches bare agy and paths unless gated as claude', t => {
	t.true(isAgyAgentProfile({command: 'agy'}));
	t.true(isAgyAgentProfile({command: '/usr/local/bin/agy --flag'}));
	t.false(isAgyAgentProfile({command: 'agy', is_claude: true}));
	t.false(isAgyAgentProfile({command: 'claude'}));
	t.false(isAgyAgentProfile({command: 'codex'}));
});

test('supportsSousChefPrompt gates prompt to claude, codex, agy, or explicit prompt_args', t => {
	t.true(supportsSousChefPrompt({command: 'claude'}));
	t.true(supportsSousChefPrompt({command: 'claude-local', is_claude: true}));
	t.true(supportsSousChefPrompt({command: '/opt/bin/codex'}));
	t.true(supportsSousChefPrompt({command: 'agy'}));
	t.true(
		supportsSousChefPrompt({command: 'custom', prompt_args: '-i {prompt}'}),
	);
	t.false(supportsSousChefPrompt({command: 'opencode', skill_prefix: '/'}));
	t.false(supportsSousChefPrompt({command: 'pi'}));
	t.false(supportsSousChefPrompt({command: 'opencode'}));
	t.false(supportsSousChefPrompt({command: 'env FOO=1 agy'}));
	t.false(supportsSousChefPrompt({command: 'claude', is_claude: false}));
});
